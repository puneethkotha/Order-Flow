-------------------------- MODULE MCInductive --------------------------
(***************************************************************************)
(* Apalache harness for checking that IndInv is an inductive invariant.    *)
(*                                                                         *)
(* IndInit assigns every state variable a value over its (bounded) type    *)
(* domain and then constrains it with IndInv, so it denotes an arbitrary    *)
(* IndInv-satisfying state. Checking `--inv=IndInv --length=1` from IndInit *)
(* verifies IndInv /\ Next => IndInv' -- the inductive step. Together with  *)
(* the base case (Init => IndInv, checked on OrderSaga.tla) this proves I1  *)
(* and I2 for all reachable states, unbounded.                             *)
(***************************************************************************)
EXTENDS OrderSaga, Apalache

IndInit ==
    /\ coord \in [ state: States, payAuth: BOOLEAN, invReserved: BOOLEAN, fulfillCount: 0..1 ]
    /\ pay \in [ auth: BOOLEAN, captured: BOOLEAN, voided: BOOLEAN, refunded: BOOLEAN,
                 failed: BOOLEAN, decided: BOOLEAN, cancelled: BOOLEAN ]
    /\ inv \in [ reserved: 0..(2 * Stock), reservedEver: BOOLEAN, released: BOOLEAN,
                 failed: BOOLEAN, cancelled: BOOLEAN ]
    /\ stockReserved \in 0..(2 * Stock)
    /\ net \in [ MsgKind -> 0..K ]
    /\ proc \in [ MsgKind -> BOOLEAN ]
    \* phases is orthogonal to IndInv (no action guard depends on it; only I8
    \* references it, and I8 is established by TLC). Generated arbitrarily.
    /\ phases = Gen(6)
    /\ IndInv

=============================================================================
