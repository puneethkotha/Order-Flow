# Spec-to-code map

A model checker proves the model, not the implementation. This map is the
honest bridge: every action in `spec/OrderSaga.tla` names the reducer branch and
the consumer it corresponds to, so a reviewer can check that the model and the
code describe the same saga.

Shared reducer: `packages/shared/src/saga/coordinator.ts` (`reduce`).
Simulator (runtime analogue): `packages/shared/src/saga/simulator.ts`.
Invariants: `packages/shared/src/invariants.ts` (same I1-I8, L1).

| TLA+ action | Reducer branch / participant handler | Service code |
|---|---|---|
| `Approve` | `reduce` case `ORDER_APPROVED` (DRAFT to APPROVED, fan out) | `OrderService.approveOrder` |
| `Duplicate` | at-least-once outbox re-send / crash-before-mark | `outbox-publisher.ts` (send then markDelivered) |
| `DeliverAP_PAY` | payment participant on `ORDER_APPROVED` (authorize or decline) | `payment-service` `order-consumer.ts` -> `PaymentService.authorizePayment` |
| `DeliverAP_INV` | inventory participant on `ORDER_APPROVED` (reserve or fail) | `inventory-service` `order-consumer.ts` -> `InventoryService.reserveInventory` |
| `DeliverPAUTH` | `reduce` case `PAYMENT_AUTHORIZED` + `tryFulfil` | `OrderService.handlePaymentAuthorized` -> `tryTransitionToFulfilling` |
| `DeliverIRES` | `reduce` case `INVENTORY_RESERVED` + `tryFulfil` | `OrderService.handleInventoryReserved` -> `tryTransitionToFulfilling` |
| `DeliverPFAIL` | `reduce` case `PAYMENT_FAILED` (cancel + compensation) | `OrderService.handlePaymentFailed` -> `cancelOrder` |
| `DeliverIFAIL` | `reduce` case `INVENTORY_FAILED` (cancel + compensation) | `OrderService.handleInventoryFailed` -> `cancelOrder` |
| `DeliverPCAP` | `reduce` case `PAYMENT_CAPTURED` (FULFILLING to COMPLETED) | `OrderService.handlePaymentCaptured` |
| `DeliverCAPREQ` | payment participant on `CAPTURE_REQUESTED` (capture) | `payment-service` on `CAPTURE_REQUESTED` -> `PaymentService.capturePayment` |
| `DeliverCANpay` | payment participant on `ORDER_CANCELLED` (void/refund) | `payment-service` on `ORDER_CANCELLED` -> `PaymentService.compensate` |
| `DeliverCANinv` | inventory participant on `ORDER_CANCELLED` (release) | `inventory-service` on `ORDER_CANCELLED` -> `InventoryService.releaseReservation` |

## Design switch

`Corrected` (TLA+ CONSTANT) mirrors the `mode: 'uncorrected' | 'corrected'` flag
on the reducer and simulator:

- `Corrected = FALSE`: `tryFulfil` emits no `CAPTURE_REQUESTED`; cancellation
  emits no compensation; `Dedup` is off (the code keys idempotency on the Kafka
  offset, which changes on re-publish).
- `Corrected = TRUE`: capture is requested on entry to FULFILLING; cancellation
  emits void/release; `Dedup` is on (the code keys idempotency on the business
  eventId).

## What each layer covers

- TLC (this spec) proves the message-layer safety and liveness: capture gating
  (I1/I2), compensation completeness (I3/I4/I5), single fulfillment (I6),
  conservation under duplication (I7), monotonic state (I8), and eventual
  resolution (L1) under weak fairness. It found the duplicate double-reserve
  (I7) counterexample on the uncorrected design.
- The fast-check scheduler test (`saga.race.test.ts`) covers the intra-process
  read-modify-write race that strands a saga in APPROVED. That defect is a
  property of two consumers sharing a process and reading outside their
  transaction; it is not expressible in this message-passing model, so it is
  verified against the code path directly.
- The Testcontainers chaos rig (`test/chaos`) re-checks I1-I8 against real Kafka
  and Postgres, closing the spec-to-code gap empirically.

## Eventual vs step invariants

I3, I4, and I5 are compensation-completion properties. Between a cancel and the
delivery of its compensation there is a legitimate in-flight window in which
stock is still reserved or an authorization is still live. In the spec they are
guarded by `Quiescent` (no messages in flight); in the code they are checked by
the chaos runner after draining each scenario. I1, I2, I6, I7, I8 are true state
invariants and hold after every step.

## Config

`spec/OrderSaga.cfg` (corrected) and `spec/OrderSagaUncorrected.cfg`
(uncorrected) with `Qty = 1`, `Stock = 2`, `K = 2` (channel bound),
`PaymentCanFail = TRUE`, `InventoryCanFail = TRUE`. Run with `spec/run-tlc.sh`.
