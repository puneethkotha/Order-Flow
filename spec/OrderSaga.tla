---------------------------- MODULE OrderSaga ----------------------------
(***************************************************************************)
(* A machine-checked model of the OrderFlow saga.                         *)
(*                                                                         *)
(* Three participants -- a coordinator (order-service), payment, and       *)
(* inventory -- communicate over an unordered, duplicating channel modeled *)
(* as a bounded multiset `net`. Duplication (the outbox at-least-once      *)
(* re-send and crash-before-mark) is modeled by the Duplicate action;      *)
(* reordering is inherent because any in-flight message may be delivered;  *)
(* idempotency is modeled by the per-recipient `proc` map.                 *)
(*                                                                         *)
(* One CONSTANT, Corrected, selects between the two designs so the same     *)
(* model demonstrates both the defect and the fix:                         *)
(*                                                                         *)
(*   Corrected = FALSE : no capture step; no compensation on cancel; dedup  *)
(*                       is effectively off (offset-keyed in the code).     *)
(*   Corrected = TRUE  : capture gated on FULFILLING; compensation voids or *)
(*                       releases on cancel; dedup by business identity.    *)
(*                                                                         *)
(* The action names map one-to-one to the reducer branches and consumers   *)
(* (see spec/SPEC_CODE_MAP.md).                                            *)
(***************************************************************************)
EXTENDS Naturals, Sequences, FiniteSets

CONSTANTS
    \* @type: Bool;
    Corrected,          \* which design to check
    \* @type: Bool;
    PaymentCanFail,     \* may the payment gateway decline?
    \* @type: Bool;
    InventoryCanFail,   \* may a reservation be rejected?
    \* @type: Int;
    Qty,                \* order quantity for the single SKU
    \* @type: Int;
    Stock,              \* physical stock of the SKU
    \* @type: Int;
    K                   \* channel bound (max copies of any message)

MsgKind == { "AP_PAY", "AP_INV", "PAUTH", "PFAIL", "IRES", "IFAIL",
             "CAPREQ", "PCAP", "CANpay", "CANinv" }

States == { "DRAFT", "APPROVED", "FULFILLING", "SHIPPED", "COMPLETED", "CANCELLED" }

\* @type: Set(<<Str, Str>>);
LegalEdges ==
    { <<"DRAFT", "APPROVED">>, <<"APPROVED", "FULFILLING">>,
      <<"APPROVED", "CANCELLED">>, <<"FULFILLING", "SHIPPED">>,
      <<"FULFILLING", "CANCELLED">>, <<"SHIPPED", "COMPLETED">>,
      <<"DRAFT", "CANCELLED">> }

VARIABLES
    \* @type: { state: Str, payAuth: Bool, invReserved: Bool, fulfillCount: Int };
    coord,
    \* @type: { auth: Bool, captured: Bool, voided: Bool, refunded: Bool, failed: Bool, decided: Bool, cancelled: Bool };
    pay,
    \* @type: { reserved: Int, reservedEver: Bool, released: Bool, failed: Bool, cancelled: Bool };
    inv,
    \* @type: Int;
    stockReserved,  \* reserved units of the SKU
    \* @type: Str -> Int;
    net,            \* in-flight multiset [MsgKind -> 0..K]
    \* @type: Str -> Bool;
    proc,           \* per-recipient dedup marks
    \* @type: Seq(Str);
    phases          \* ordered history of the order state

vars == <<coord, pay, inv, stockReserved, net, proc, phases>>

Init ==
    /\ coord = [state |-> "DRAFT", payAuth |-> FALSE, invReserved |-> FALSE, fulfillCount |-> 0]
    /\ pay = [auth |-> FALSE, captured |-> FALSE, voided |-> FALSE, refunded |-> FALSE,
              failed |-> FALSE, decided |-> FALSE, cancelled |-> FALSE]
    /\ inv = [reserved |-> 0, reservedEver |-> FALSE, released |-> FALSE,
              failed |-> FALSE, cancelled |-> FALSE]
    /\ stockReserved = 0
    /\ net = [m \in MsgKind |-> 0]
    /\ proc = [m \in MsgKind |-> FALSE]
    /\ phases = <<"DRAFT">>

Dedup(m) == Corrected /\ proc[m]

----------------------------------------------------------------------------
(* Operator interaction: approve the order. *)
Approve ==
    /\ coord.state = "DRAFT"
    /\ coord' = [coord EXCEPT !.state = "APPROVED"]
    /\ phases' = Append(phases, "APPROVED")
    /\ net' = [net EXCEPT !["AP_PAY"] = 1, !["AP_INV"] = 1]
    /\ UNCHANGED <<pay, inv, stockReserved, proc>>

(* At-least-once / duplicate / crash-before-mark: re-enqueue a live message. *)
Duplicate ==
    /\ \E m \in MsgKind : net[m] > 0 /\ net[m] < K /\ net' = [net EXCEPT ![m] = @ + 1]
    /\ UNCHANGED <<coord, pay, inv, stockReserved, proc, phases>>

----------------------------------------------------------------------------
(* payment consumes ORDER_APPROVED -> authorize or decline. Idempotent by
   order identity (pay.decided), mirroring the idempotencyKey on the call. *)
DeliverAP_PAY ==
    /\ net["AP_PAY"] > 0
    /\ IF Dedup("AP_PAY") \/ pay.decided \/ pay.cancelled
       THEN /\ net' = [net EXCEPT !["AP_PAY"] = @ - 1]
            /\ UNCHANGED <<coord, pay, inv, stockReserved, proc, phases>>
       ELSE /\ proc' = [proc EXCEPT !["AP_PAY"] = TRUE]
            /\ \/ /\ pay' = [pay EXCEPT !.auth = TRUE, !.decided = TRUE]
                  /\ net' = [net EXCEPT !["AP_PAY"] = @ - 1, !["PAUTH"] = 1]
               \/ /\ PaymentCanFail
                  /\ pay' = [pay EXCEPT !.failed = TRUE, !.decided = TRUE]
                  /\ net' = [net EXCEPT !["AP_PAY"] = @ - 1, !["PFAIL"] = 1]
            /\ UNCHANGED <<coord, inv, stockReserved, phases>>

(* inventory consumes ORDER_APPROVED -> reserve or fail. No business-level
   idempotency: reprocessing re-reserves, which is the duplicate defect. *)
DeliverAP_INV ==
    /\ net["AP_INV"] > 0
    /\ IF Dedup("AP_INV") \/ inv.cancelled
       THEN /\ net' = [net EXCEPT !["AP_INV"] = @ - 1]
            /\ UNCHANGED <<coord, pay, inv, stockReserved, proc, phases>>
       ELSE /\ proc' = [proc EXCEPT !["AP_INV"] = TRUE]
            /\ \/ /\ Stock - stockReserved >= Qty
                  /\ inv' = [inv EXCEPT !.reserved = @ + Qty, !.reservedEver = TRUE]
                  /\ stockReserved' = stockReserved + Qty
                  /\ net' = [net EXCEPT !["AP_INV"] = @ - 1, !["IRES"] = 1]
               \/ /\ InventoryCanFail
                  /\ inv' = [inv EXCEPT !.failed = TRUE]
                  /\ stockReserved' = stockReserved
                  /\ net' = [net EXCEPT !["AP_INV"] = @ - 1, !["IFAIL"] = 1]
            /\ UNCHANGED <<coord, pay, phases>>

----------------------------------------------------------------------------
(* coordinator join: set the payment leg, then transition to FULFILLING iff
   both legs are ready. Corrected additionally requests capture. *)
\* @type: ({ state: Str, payAuth: Bool, invReserved: Bool, fulfillCount: Int }) => Bool;
TryFulfil(c1) ==
    c1.state = "APPROVED" /\ c1.payAuth /\ c1.invReserved /\ c1.fulfillCount = 0

DeliverPAUTH ==
    /\ net["PAUTH"] > 0
    /\ IF Dedup("PAUTH")
       THEN /\ net' = [net EXCEPT !["PAUTH"] = @ - 1]
            /\ UNCHANGED <<coord, pay, inv, stockReserved, proc, phases>>
       ELSE LET c1 == [coord EXCEPT !.payAuth = TRUE] IN
            /\ proc' = [proc EXCEPT !["PAUTH"] = TRUE]
            /\ IF TryFulfil(c1)
               THEN /\ coord' = [c1 EXCEPT !.state = "FULFILLING", !.fulfillCount = 1]
                    /\ phases' = Append(phases, "FULFILLING")
                    /\ net' = IF Corrected
                              THEN [net EXCEPT !["PAUTH"] = @ - 1, !["CAPREQ"] = 1]
                              ELSE [net EXCEPT !["PAUTH"] = @ - 1]
               ELSE /\ coord' = c1
                    /\ phases' = phases
                    /\ net' = [net EXCEPT !["PAUTH"] = @ - 1]
            /\ UNCHANGED <<pay, inv, stockReserved>>

DeliverIRES ==
    /\ net["IRES"] > 0
    /\ IF Dedup("IRES")
       THEN /\ net' = [net EXCEPT !["IRES"] = @ - 1]
            /\ UNCHANGED <<coord, pay, inv, stockReserved, proc, phases>>
       ELSE LET c1 == [coord EXCEPT !.invReserved = TRUE] IN
            /\ proc' = [proc EXCEPT !["IRES"] = TRUE]
            /\ IF TryFulfil(c1)
               THEN /\ coord' = [c1 EXCEPT !.state = "FULFILLING", !.fulfillCount = 1]
                    /\ phases' = Append(phases, "FULFILLING")
                    /\ net' = IF Corrected
                              THEN [net EXCEPT !["IRES"] = @ - 1, !["CAPREQ"] = 1]
                              ELSE [net EXCEPT !["IRES"] = @ - 1]
               ELSE /\ coord' = c1
                    /\ phases' = phases
                    /\ net' = [net EXCEPT !["IRES"] = @ - 1]
            /\ UNCHANGED <<pay, inv, stockReserved>>

(* coordinator cancels on a failure. Corrected emits compensation. *)
CancelOn(m) ==
    /\ net[m] > 0
    /\ IF Dedup(m)
       THEN /\ net' = [net EXCEPT ![m] = @ - 1]
            /\ UNCHANGED <<coord, pay, inv, stockReserved, proc, phases>>
       ELSE LET live == coord.state \in {"APPROVED", "FULFILLING"} IN
            /\ proc' = [proc EXCEPT ![m] = TRUE]
            /\ coord' = IF live THEN [coord EXCEPT !.state = "CANCELLED"] ELSE coord
            /\ phases' = IF live THEN Append(phases, "CANCELLED") ELSE phases
            /\ net' = IF live /\ Corrected
                      THEN [net EXCEPT ![m] = @ - 1, !["CANpay"] = 1, !["CANinv"] = 1]
                      ELSE [net EXCEPT ![m] = @ - 1]
            /\ UNCHANGED <<pay, inv, stockReserved>>

DeliverPFAIL == CancelOn("PFAIL")
DeliverIFAIL == CancelOn("IFAIL")

(* coordinator drives fulfilment to completion once payment is captured. *)
DeliverPCAP ==
    /\ net["PCAP"] > 0
    /\ IF Dedup("PCAP")
       THEN /\ net' = [net EXCEPT !["PCAP"] = @ - 1]
            /\ UNCHANGED <<coord, pay, inv, stockReserved, proc, phases>>
       ELSE /\ proc' = [proc EXCEPT !["PCAP"] = TRUE]
            /\ net' = [net EXCEPT !["PCAP"] = @ - 1]
            /\ IF coord.state = "FULFILLING"
               THEN /\ coord' = [coord EXCEPT !.state = "COMPLETED"]
                    /\ phases' = Append(Append(phases, "SHIPPED"), "COMPLETED")
               ELSE /\ coord' = coord
                    /\ phases' = phases
            /\ UNCHANGED <<pay, inv, stockReserved>>

----------------------------------------------------------------------------
(* payment consumes CAPTURE_REQUESTED -> capture (only if authorized). *)
DeliverCAPREQ ==
    /\ net["CAPREQ"] > 0
    /\ IF Dedup("CAPREQ")
       THEN /\ net' = [net EXCEPT !["CAPREQ"] = @ - 1]
            /\ UNCHANGED <<coord, pay, inv, stockReserved, proc, phases>>
       ELSE /\ proc' = [proc EXCEPT !["CAPREQ"] = TRUE]
            /\ IF pay.auth /\ ~pay.captured
               THEN /\ pay' = [pay EXCEPT !.captured = TRUE]
                    /\ net' = [net EXCEPT !["CAPREQ"] = @ - 1, !["PCAP"] = 1]
               ELSE /\ pay' = pay
                    /\ net' = [net EXCEPT !["CAPREQ"] = @ - 1]
            /\ UNCHANGED <<coord, inv, stockReserved, phases>>

(* payment consumes ORDER_CANCELLED -> void or refund the authorization. *)
DeliverCANpay ==
    /\ net["CANpay"] > 0
    /\ IF Dedup("CANpay")
       THEN /\ net' = [net EXCEPT !["CANpay"] = @ - 1]
            /\ UNCHANGED <<coord, pay, inv, stockReserved, proc, phases>>
       ELSE /\ proc' = [proc EXCEPT !["CANpay"] = TRUE]
            /\ net' = [net EXCEPT !["CANpay"] = @ - 1]
            /\ pay' = IF pay.captured /\ ~pay.refunded
                      THEN [pay EXCEPT !.refunded = TRUE, !.cancelled = TRUE]
                      ELSE IF pay.auth /\ ~pay.voided /\ ~pay.captured
                           THEN [pay EXCEPT !.voided = TRUE, !.cancelled = TRUE]
                           ELSE [pay EXCEPT !.cancelled = TRUE]
            /\ UNCHANGED <<coord, inv, stockReserved, phases>>

(* inventory consumes ORDER_CANCELLED -> release any active reservation. *)
DeliverCANinv ==
    /\ net["CANinv"] > 0
    /\ IF Dedup("CANinv")
       THEN /\ net' = [net EXCEPT !["CANinv"] = @ - 1]
            /\ UNCHANGED <<coord, pay, inv, stockReserved, proc, phases>>
       ELSE /\ proc' = [proc EXCEPT !["CANinv"] = TRUE]
            /\ net' = [net EXCEPT !["CANinv"] = @ - 1]
            /\ IF inv.reserved > 0
               THEN /\ stockReserved' = stockReserved - inv.reserved
                    /\ inv' = [inv EXCEPT !.reserved = 0, !.released = TRUE, !.cancelled = TRUE]
               ELSE /\ stockReserved' = stockReserved
                    /\ inv' = [inv EXCEPT !.cancelled = TRUE]
            /\ UNCHANGED <<coord, pay, phases>>

----------------------------------------------------------------------------
Deliver ==
    \/ DeliverAP_PAY \/ DeliverAP_INV \/ DeliverPAUTH \/ DeliverIRES
    \/ DeliverPFAIL \/ DeliverIFAIL \/ DeliverPCAP \/ DeliverCAPREQ
    \/ DeliverCANpay \/ DeliverCANinv

Next == Approve \/ Duplicate \/ Deliver

(* Weak fairness on the operator step and on each individual delivery: a
   message that stays in flight is eventually delivered. Duplicate (a fault) is
   deliberately not fair, so it cannot be used to starve real deliveries. *)
Fairness ==
    /\ WF_vars(Approve)
    /\ WF_vars(DeliverAP_PAY) /\ WF_vars(DeliverAP_INV)
    /\ WF_vars(DeliverPAUTH)  /\ WF_vars(DeliverIRES)
    /\ WF_vars(DeliverPFAIL)  /\ WF_vars(DeliverIFAIL)
    /\ WF_vars(DeliverPCAP)   /\ WF_vars(DeliverCAPREQ)
    /\ WF_vars(DeliverCANpay) /\ WF_vars(DeliverCANinv)

Spec == Init /\ [][Next]_vars /\ Fairness

----------------------------------------------------------------------------
(* Invariants. *)
Quiescent == \A m \in MsgKind : net[m] = 0

TypeOK ==
    /\ coord.state \in States
    /\ coord.fulfillCount \in 0..1
    /\ stockReserved \in 0..(2 * Stock)
    /\ inv.reserved \in 0..(2 * Stock)

I1 == pay.captured => inv.reservedEver
I2 == pay.captured => pay.auth
I3 == (Quiescent /\ coord.state = "CANCELLED") => (~pay.captured \/ pay.refunded)
I4 == (Quiescent /\ coord.state = "CANCELLED") => inv.reserved = 0
I5 == (Quiescent /\ coord.state = "CANCELLED") => (pay.voided \/ pay.refunded \/ ~pay.auth)
I6 == coord.fulfillCount <= 1
I7 == /\ stockReserved = inv.reserved
      /\ inv.reserved <= Qty
      /\ stockReserved >= 0
      /\ stockReserved <= Stock
I8 == \A i \in 1..(Len(phases) - 1) : <<phases[i], phases[i + 1]>> \in LegalEdges

(* Liveness (L1): every order eventually reaches, and stays in, a terminal
   state (COMPLETED or a clean CANCELLED). *)
Terminal == coord.state \in {"COMPLETED", "CANCELLED"}
L1 == <>[]Terminal

(* Conjunction of the safety invariants, for a single symbolic check. *)
AllSafety == I1 /\ I2 /\ I3 /\ I4 /\ I5 /\ I6 /\ I7 /\ I8

(***************************************************************************)
(* An inductive strengthening that proves I1 (capture implies reserve)     *)
(* and I2 (capture implies authorize) for ALL reachable states, not just    *)
(* those within a bounded depth. It tracks the chain by which a capture can  *)
(* only exist once an authorization and a reservation exist: the strengthen  *)
(* -ing facts about in-flight messages make each clause preserved by Next.   *)
(*                                                                         *)
(* Apalache checks: Init => IndInv (base) and IndInv /\ Next => IndInv'      *)
(* (step). Since IndInv => I1 /\ I2, this is an unbounded guarantee.         *)
(***************************************************************************)
IndInv ==
    /\ \A m \in MsgKind : net[m] >= 0
    \* authorization chain (proves I2)
    /\ (net["PAUTH"] > 0 => pay.auth)
    /\ (coord.payAuth => pay.auth)
    /\ (net["CAPREQ"] > 0 => pay.auth)
    /\ (net["PCAP"] > 0 => pay.auth)
    /\ (pay.captured => pay.auth)
    \* reservation chain (proves I1)
    /\ (net["IRES"] > 0 => inv.reservedEver)
    /\ (coord.invReserved => inv.reservedEver)
    /\ (net["CAPREQ"] > 0 => inv.reservedEver)
    /\ (net["PCAP"] > 0 => inv.reservedEver)
    /\ (pay.captured => inv.reservedEver)

=============================================================================
