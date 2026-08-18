/**
 * Reproduction of the coordinator read-modify-write race (the stuck-saga
 * liveness bug) using fast-check's scheduler to explore async interleavings.
 *
 * This models the two coordinator handlers that run in the same order-service
 * process (see services/order-service/src/index.ts wiring the payment and
 * inventory consumers, and OrderService.handlePaymentAuthorized /
 * handleInventoryReserved -> tryTransitionToFulfilling).
 *
 * The defect: tryTransitionToFulfilling is passed the transaction `client`,
 * but its reads use the pool (OrderRepository.findById and
 * StateTrackingRepository.findByOrderId). Under READ COMMITTED a pool read
 * cannot see the handler's own in-flight write, so a handler evaluates the join
 * predicate against a snapshot that excludes its own contribution. The order is
 * left stranded in APPROVED: neither handler ever observes both flags set.
 *
 * The fix (Phase 3) reads through the transaction client and takes
 * SELECT ... FOR UPDATE on the tracking row, so the write is visible to the
 * subsequent read and the two handlers are serialized. Modeled here as an
 * uninterrupted critical section over the shared tracking row.
 */

import fc from 'fast-check';

interface Tracking {
  paymentAuthorized: boolean;
  inventoryReserved: boolean;
}

interface Store {
  committed: Tracking; // what a separate (pool) connection can read
  orderState: 'APPROVED' | 'FULFILLING';
  fulfillCount: number;
}

function fresh(): Store {
  return {
    committed: { paymentAuthorized: false, inventoryReserved: false },
    orderState: 'APPROVED',
    fulfillCount: 0,
  };
}

type Field = keyof Tracking;

const tick = (s: fc.Scheduler) => s.schedule(Promise.resolve());

/**
 * Uncorrected handler: writes its own flag to an uncommitted buffer, reads the
 * committed snapshot (which excludes its own write), decides, then commits.
 */
async function uncorrectedHandler(store: Store, field: Field, s: fc.Scheduler): Promise<void> {
  const pending: Tracking = { ...store.committed, [field]: true };
  await tick(s);
  const tracking = store.committed; // pool read: own uncommitted write not visible
  await tick(s);
  if (
    store.orderState === 'APPROVED' &&
    tracking.paymentAuthorized &&
    tracking.inventoryReserved &&
    store.fulfillCount === 0
  ) {
    store.orderState = 'FULFILLING';
    store.fulfillCount += 1;
  }
  await tick(s);
  store.committed = pending; // commit
}

/**
 * Corrected handler: the write and the join read happen in one uninterrupted
 * critical section over the tracking row (read through the transaction client,
 * SELECT ... FOR UPDATE), so the read sees the write and the handlers serialize.
 */
async function correctedHandler(store: Store, field: Field, s: fc.Scheduler): Promise<void> {
  await tick(s);
  // critical section: no await between write and decision
  store.committed[field] = true;
  if (
    store.orderState === 'APPROVED' &&
    store.committed.paymentAuthorized &&
    store.committed.inventoryReserved &&
    store.fulfillCount === 0
  ) {
    store.orderState = 'FULFILLING';
    store.fulfillCount += 1;
  }
}

describe('coordinator join under interleaving', () => {
  it('corrected design reaches FULFILLING under every interleaving', async () => {
    await fc.assert(
      fc.asyncProperty(fc.scheduler(), async (s) => {
        const store = fresh();
        const a = correctedHandler(store, 'paymentAuthorized', s);
        const b = correctedHandler(store, 'inventoryReserved', s);
        await s.waitAll();
        await Promise.all([a, b]);
        return store.orderState === 'FULFILLING' && store.fulfillCount === 1;
      }),
      { numRuns: 2000 }
    );
  });

  it('uncorrected design is stranded in APPROVED (stuck-saga counterexample)', async () => {
    const run = await fc.check(
      fc.asyncProperty(fc.scheduler(), async (s) => {
        const store = fresh();
        const a = uncorrectedHandler(store, 'paymentAuthorized', s);
        const b = uncorrectedHandler(store, 'inventoryReserved', s);
        await s.waitAll();
        await Promise.all([a, b]);
        return store.orderState === 'FULFILLING';
      }),
      { numRuns: 2000, endOnFailure: false }
    );
    expect(run.failed).toBe(true);
    // eslint-disable-next-line no-console
    console.log(
      `[uncorrected] stuck-saga counterexample: seed=${run.seed} numShrinks=${run.numShrinks} ` +
        `-> order remains APPROVED (L1 liveness violated)`
    );
  });
});
