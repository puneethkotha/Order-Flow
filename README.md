# OrderFlow

An order-processing saga whose safety and liveness invariants are specified as
executable predicates, machine-checked with TLA+ (TLC and Apalache), exercised
against randomized event orderings with property-based tests, and re-checked
against real Kafka and Postgres under injected faults. Correctness under failure
is a set of numbers here, not an adjective.

Three services (Order, Payment, Inventory) each own a Postgres database and
communicate over Kafka via the transactional outbox pattern. Order-service is
the coordinator; payment and inventory are choreographed participants.

## What is verified

Nine invariants, one catalog (`packages/shared/src/invariants.ts`), shared by the
reducer tests, the formal spec, the chaos runner, and the trace viewer:

| Id | Kind | Statement |
|----|------|-----------|
| I1 | safety | capture implies inventory was reserved |
| I2 | safety | capture implies payment was authorized |
| I3 | safety (eventual) | a cancelled order is not captured, or was refunded |
| I4 | safety (eventual) | a terminally cancelled order holds zero reserved stock |
| I5 | safety (eventual) | a terminally cancelled order holds no live authorization |
| I6 | safety | at most one FULFILLING transition per order |
| I7 | safety | reserved stock equals the sum of active reservations, within bounds |
| I8 | safety | order state advances only along the legal DAG |
| L1 | liveness | every order eventually reaches COMPLETED or a clean CANCELLED |

## Evidence (all produced by the commands below)

- **Property-based (fast-check):** 100,000 generated sequences over the corrected
  design pass with 0 invariant violations (~5s per property). Against the
  uncorrected design, fast-check finds and shrinks counterexamples for the stock
  leak (I4), held authorization (I5), and duplicate over-reservation (I7); a
  scheduler test reproduces the stuck-saga liveness bug.
- **TLA+ / TLC:** the corrected design has 0 violations across 14,471 distinct
  states (search depth 20) and satisfies L1 under weak fairness. The uncorrected
  design yields a 5-state counterexample (a re-delivered ORDER_APPROVED
  double-reserves, I7).
- **Apalache (symbolic):** `IndInv` is proven inductive (base and step), giving
  an unbounded guarantee for I1 and I2; a bounded symbolic check confirms all
  safety invariants to length 6.
- **Chaos runner:** 1,000 seeded scenarios across four fault families
  (partition, duplicate, reorder, crash; 250 each) pass with 0 violations on the
  corrected design; reproduction from a seed is 100%.
- **Testcontainers (real infra):** real Postgres proves the coordinator join
  reaches FULFILLING under concurrent handlers, optimistic concurrency rejects a
  stale update, reservation release restores stock (I4), and payment void/refund
  work (I5); a real Kafka (KRaft) test proves a duplicated ORDER_APPROVED is
  applied exactly once.

## Bugs found and fixed

1. **Stuck saga (liveness).** `tryTransitionToFulfilling` read the tracking row
   outside its own transaction, so neither coordinator handler saw the other's
   write and the order stalled in APPROVED. Fixed by reading through the
   transaction client with `SELECT ... FOR UPDATE`.
2. **Permanent stock leak (I4).** No consumer handled `ORDER_CANCELLED`, so a
   reserved-then-cancelled order never released stock. Fixed by an inventory
   compensation consumer that releases the reservation.
3. **Held authorization (I5).** A cancelled order's authorization was never
   voided. Fixed by a payment compensation consumer that voids or refunds.

Two further correctness gaps were closed: idempotency is now keyed on the
business eventId and written inside the business transaction (offset-keyed dedup
broke on outbox re-publish), and `OrderRepository.save` takes an optimistic
version guard. An explicit payment capture step, issued only from FULFILLING,
makes "captured implies reserved" a real, enforced invariant.

## Architecture

```
                 order.events
   Order  ────────────────────────▶  Payment    (authorize, capture, void/refund)
 (coordinator) ◀───────────────────  Inventory  (reserve, release)
      │  payment.events / inventory.events
      ▼
 SagaCoordinator reducer (pure): state x event -> (state', commands)
```

The coordinator's decision logic is a pure reducer
(`packages/shared/src/saga/coordinator.ts`) mirrored by the TLA+ spec and driven
by the property tests. A deterministic simulator
(`packages/shared/src/saga/simulator.ts`) interprets it against payment and
inventory participants over an unordered, duplicating channel, and is the source
of both the chaos scenarios and the committed trace bundles.

## Quick start

```bash
npm install
npm run build
npm test                 # unit + property tests (shared + services)
npm run lint

# formal model checking (needs a JDK 11+; downloads tla2tools.jar if absent)
npm run spec:tlc

# real-infrastructure integration tests (needs Docker)
npm run test:integration --workspace=services/order-service
npm run test:integration --workspace=services/payment-service
npm run test:integration --workspace=services/inventory-service

# seeded chaos scenarios
npm run chaos -- --seed 1 --scenarios 1000

# regenerate the trace bundles for the viewer
npm run traces
```

To run the full stack locally:

```bash
npm run docker:up        # Kafka (KRaft, single broker) + Postgres
cd services/order-service && npm run migrate
cd ../payment-service && npm run migrate
cd ../inventory-service && npm run migrate && npm run seed
npm run services:dev
npm run demo
```

## Explorable trace

`docs/` is a static viewer (GitHub Pages) that loads the committed trace bundles
and lets you flip the same scenario between the uncorrected and corrected design
on one seed. The invariant rail is green until the exact step an invariant
breaks, then red.

## Formal model

- `spec/OrderSaga.tla` — the PlusCal-style TLA+ model and invariants I1-I8, L1.
- `spec/run-tlc.sh` — TLC on the corrected and uncorrected configs.
- `spec/run-apalache.sh` — Apalache type check, inductive proof, bounded check.
- `spec/SPEC_CODE_MAP.md` — each action mapped to its reducer branch and consumer.
- `spec/tlc-report.txt`, `spec/apalache-report.txt` — committed run logs.

## Tech stack

TypeScript, Node.js 20, Fastify, Kafka (kafkajs, KRaft), PostgreSQL, Pino,
prom-client, Jest, fast-check, Testcontainers, Toxiproxy, TLA+ (TLC, Apalache).

## Scope and limitations

- Single Kafka broker, replication factor 1: a demo-scoped decision, not
  production HA.
- The TLA+ model proves the model; the Testcontainers rig re-checks the same
  invariants against real infrastructure, and `SPEC_CODE_MAP.md` bridges the two.
  The read-modify-write race is a property of the running process and is verified
  against the code path (fast-check scheduler test and a real-Postgres
  concurrency test), not in the message-passing model.
- The 1,000-scenario chaos runner uses the deterministic single-process
  simulator (seeded, reproducible); Toxiproxy plus real Kafka/Postgres cover the
  network and delivery layers empirically.

## Documentation

- [Architecture](docs/ARCHITECTURE.md)
- [Local development](docs/LOCAL_DEV.md)
- [Runbook](docs/RUNBOOK.md)
- [Verification checklist](VERIFICATION.md)

## License

MIT
