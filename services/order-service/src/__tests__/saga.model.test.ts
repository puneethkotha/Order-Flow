/**
 * Property-based, model-based tests of the saga.
 *
 * The pure coordinator reducer and the deterministic simulator (both in
 * @orderflow/shared) are driven with randomized order sets, payment outcomes,
 * and message-layer fault schedules. After running each generated scenario to
 * quiescence we assert the invariant catalog (I1-I8 safety, L1 liveness).
 *
 * Against the CORRECTED design every generated scenario holds.
 * Against the UNCORRECTED design fast-check finds and shrinks counterexamples
 * that reproduce the real defects (permanent stock leak, held authorization,
 * and duplicate-driven over-reservation).
 */

import fc from 'fast-check';
import {
  SagaSimulator,
  FaultKind,
  SagaMode,
  InvariantReport,
} from '@orderflow/shared';

const FC_RUNS = Number(process.env.FC_RUNS ?? 20000);

const SKUS = ['SKU-A', 'SKU-B', 'SKU-C'] as const;

interface Scenario {
  orders: { items: { sku: string; quantity: number }[]; cancel: boolean }[];
  paymentSuccessRate: number;
  faults: FaultKind[];
  seed: number;
}

const arbScenario: fc.Arbitrary<Scenario> = fc.record({
  orders: fc.array(
    fc.record({
      items: fc.array(
        fc.record({
          sku: fc.constantFrom(...SKUS),
          quantity: fc.integer({ min: 1, max: 4 }),
        }),
        { minLength: 1, maxLength: 2 }
      ),
      cancel: fc.boolean(),
    }),
    { minLength: 1, maxLength: 3 }
  ),
  paymentSuccessRate: fc.constantFrom(0, 0.5, 1),
  faults: fc.subarray<FaultKind>(['duplicate', 'reorder', 'drop', 'crash']),
  seed: fc.integer({ min: 1, max: 2 ** 31 - 1 }),
});

function runScenario(
  mode: SagaMode,
  s: Scenario
): { safetyViolation: InvariantReport | null; liveness: InvariantReport[] } {
  // Generous stock so most orders can reserve; conservation (I7) is still
  // exact, and low-stock orders exercise the INVENTORY_FAILED path.
  const sim = new SagaSimulator({
    mode,
    stock: { 'SKU-A': 20, 'SKU-B': 20, 'SKU-C': 20 },
    paymentSuccessRate: s.paymentSuccessRate,
    seed: s.seed,
  });

  s.orders.forEach((o, i) => {
    const id = `order-${i}`;
    sim.createOrder(id, o.items);
    sim.approveOrder(id);
  });

  // Interleave an operator cancel for flagged orders (drives compensation).
  s.orders.forEach((o, i) => {
    if (o.cancel) sim.cancelOrder(`order-${i}`);
  });

  const { safetyViolation, liveness } = sim.runChecked({ faults: s.faults });
  return { safetyViolation, liveness };
}

describe('saga model (corrected design)', () => {
  it(`holds all safety invariants over ${FC_RUNS} generated scenarios`, () => {
    fc.assert(
      fc.property(arbScenario, (s) => {
        const { safetyViolation } = runScenario('corrected', s);
        return safetyViolation === null;
      }),
      { numRuns: FC_RUNS }
    );
  });

  it(`resolves every order (L1) over ${FC_RUNS} generated scenarios`, () => {
    fc.assert(
      fc.property(arbScenario, (s) => {
        const { liveness } = runScenario('corrected', s);
        return liveness.every((r) => r.holds);
      }),
      { numRuns: FC_RUNS }
    );
  });
});

describe('saga model (uncorrected design) reproduces real defects', () => {
  it('fast-check finds a shrunk counterexample violating safety', () => {
    const run = fc.check(
      fc.property(arbScenario, (s) => runScenario('uncorrected', s).safetyViolation === null),
      { numRuns: FC_RUNS, endOnFailure: false }
    );
    expect(run.failed).toBe(true);
    const counterexample = run.counterexample?.[0] as Scenario;
    const violated = runScenario('uncorrected', counterexample).safetyViolation;
    // eslint-disable-next-line no-console
    console.log(
      `[uncorrected] safety counterexample: seed=${run.seed} numShrinks=${run.numShrinks} ` +
        `orders=${counterexample.orders.length} faults=[${counterexample.faults.join(',')}] ` +
        `firstViolation=${violated?.id} (${violated?.title})`
    );
    expect(violated).not.toBeNull();
  });

  it('permanent stock leak: reserve then payment failure leaves stock reserved after cancel (I4)', () => {
    const sim = new SagaSimulator({
      mode: 'uncorrected',
      stock: { 'SKU-A': 10 },
      paymentSuccessRate: 0, // force PAYMENT_FAILED
      seed: 1,
    });
    sim.createOrder('o1', [{ sku: 'SKU-A', quantity: 3 }]);
    sim.approveOrder('o1');
    // Deliver the inventory leg first so the reservation is granted, then the
    // failing payment leg so the order is cancelled with stock still held.
    let guard = 0;
    while (!sim.isQuiescent() && guard++ < 50) {
      const pending = sim.pending();
      const invIdx = pending.findIndex((m) => m.to === 'inventory');
      sim.deliver(invIdx >= 0 ? invIdx : 0);
    }
    const world = sim.snapshot();
    expect(world.orders['o1'].state).toBe('CANCELLED');
    expect(world.reservations['o1'].reservedQty).toBe(3); // leaked
    const report = sim.safetyReport().find((r) => r.id === 'I4');
    expect(report?.holds).toBe(false);
  });

  it('held authorization: authorize then inventory failure leaves funds held after cancel (I5)', () => {
    const sim = new SagaSimulator({
      mode: 'uncorrected',
      stock: { 'SKU-A': 1 }, // too little for the order -> INVENTORY_FAILED
      paymentSuccessRate: 1, // force PAYMENT_AUTHORIZED
      seed: 1,
    });
    sim.createOrder('o1', [{ sku: 'SKU-A', quantity: 5 }]);
    sim.approveOrder('o1');
    let guard = 0;
    while (!sim.isQuiescent() && guard++ < 50) sim.deliver(0);
    const world = sim.snapshot();
    expect(world.orders['o1'].state).toBe('CANCELLED');
    expect(world.payments['o1'].authorized).toBe(true);
    expect(world.payments['o1'].voided).toBe(false); // never voided
    const report = sim.safetyReport().find((r) => r.id === 'I5');
    expect(report?.holds).toBe(false);
  });

  it('duplicate delivery double-reserves under offset-keyed dedup (I7)', () => {
    const sim = new SagaSimulator({
      mode: 'uncorrected',
      stock: { 'SKU-A': 10 },
      paymentSuccessRate: 1,
      seed: 1,
    });
    sim.createOrder('o1', [{ sku: 'SKU-A', quantity: 2 }]);
    sim.approveOrder('o1');
    // Duplicate the ORDER_APPROVED destined for inventory, then deliver both.
    const pending = sim.pending();
    const invIdx = pending.findIndex((m) => m.to === 'inventory' && m.type === 'ORDER_APPROVED');
    sim.duplicate(invIdx);
    let guard = 0;
    while (!sim.isQuiescent() && guard++ < 50) sim.deliver(0);
    const world = sim.snapshot();
    expect(world.reservations['o1'].reservedQty).toBe(4); // 2 reserved twice
    expect(world.stock['SKU-A'].reserved).toBe(4);
    const report = sim.safetyReport().find((r) => r.id === 'I7');
    expect(report?.holds).toBe(false);
  });
});

describe('saga model (corrected design) fixes the same scenarios', () => {
  it('releases stock after cancel (I4 holds)', () => {
    const sim = new SagaSimulator({
      mode: 'corrected',
      stock: { 'SKU-A': 10 },
      paymentSuccessRate: 0,
      seed: 1,
    });
    sim.createOrder('o1', [{ sku: 'SKU-A', quantity: 3 }]);
    sim.approveOrder('o1');
    let guard = 0;
    while (!sim.isQuiescent() && guard++ < 50) {
      const pending = sim.pending();
      const invIdx = pending.findIndex((m) => m.to === 'inventory' && m.type === 'ORDER_APPROVED');
      sim.deliver(invIdx >= 0 ? invIdx : 0);
    }
    const world = sim.snapshot();
    expect(world.orders['o1'].state).toBe('CANCELLED');
    expect(world.reservations['o1'].reservedQty).toBe(0);
    expect(world.stock['SKU-A'].reserved).toBe(0);
    expect(sim.safetyReport().every((r) => r.holds)).toBe(true);
  });

  it('voids authorization after cancel (I5 holds)', () => {
    const sim = new SagaSimulator({
      mode: 'corrected',
      stock: { 'SKU-A': 1 },
      paymentSuccessRate: 1,
      seed: 1,
    });
    sim.createOrder('o1', [{ sku: 'SKU-A', quantity: 5 }]);
    sim.approveOrder('o1');
    let guard = 0;
    while (!sim.isQuiescent() && guard++ < 50) sim.deliver(0);
    const world = sim.snapshot();
    expect(world.orders['o1'].state).toBe('CANCELLED');
    expect(world.payments['o1'].voided).toBe(true);
    expect(sim.safetyReport().every((r) => r.holds)).toBe(true);
  });

  it('deduplicates by eventId so duplicates do not double-reserve (I7 holds)', () => {
    const sim = new SagaSimulator({
      mode: 'corrected',
      stock: { 'SKU-A': 10 },
      paymentSuccessRate: 1,
      seed: 1,
    });
    sim.createOrder('o1', [{ sku: 'SKU-A', quantity: 2 }]);
    sim.approveOrder('o1');
    const pending = sim.pending();
    const invIdx = pending.findIndex((m) => m.to === 'inventory' && m.type === 'ORDER_APPROVED');
    sim.duplicate(invIdx);
    let guard = 0;
    while (!sim.isQuiescent() && guard++ < 50) sim.deliver(0);
    const world = sim.snapshot();
    expect(world.reservations['o1'].reservedQty).toBe(2);
    expect(world.stock['SKU-A'].reserved).toBe(2);
    expect(sim.safetyReport().every((r) => r.holds)).toBe(true);
  });
});
