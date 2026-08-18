import {
  INVARIANTS,
  SAFETY_INVARIANTS,
  LIVENESS_INVARIANTS,
  STEP_SAFETY_INVARIANTS,
  EVENTUAL_SAFETY_INVARIANTS,
  SagaSimulator,
  checkSafety,
} from '../index';

describe('invariant catalog', () => {
  it('has 8 safety invariants and 1 liveness invariant', () => {
    expect(SAFETY_INVARIANTS).toHaveLength(8);
    expect(LIVENESS_INVARIANTS).toHaveLength(1);
    expect(INVARIANTS).toHaveLength(9);
  });

  it('partitions safety invariants into step and eventual timings', () => {
    expect(STEP_SAFETY_INVARIANTS.map((i) => i.id).sort()).toEqual([
      'I1',
      'I2',
      'I6',
      'I7',
      'I8',
    ]);
    expect(EVENTUAL_SAFETY_INVARIANTS.map((i) => i.id).sort()).toEqual(['I3', 'I4', 'I5']);
  });

  it('every invariant is a total predicate with a non-empty statement', () => {
    for (const inv of INVARIANTS) {
      expect(inv.statement.trim().length).toBeGreaterThan(0);
      expect(typeof inv.check).toBe('function');
    }
  });

  it('holds on an empty world', () => {
    const sim = new SagaSimulator({ mode: 'corrected', stock: {} });
    expect(checkSafety(sim.snapshot()).every((r) => r.holds)).toBe(true);
  });
});
