import { reduce, initialCoordinatorState } from '../saga/coordinator';

describe('SagaCoordinator reducer', () => {
  it('approves a draft and fans out ORDER_APPROVED to both participants', () => {
    const s0 = initialCoordinatorState('o1', [{ sku: 'A', quantity: 1 }]);
    const { state, commands, transitions } = reduce(s0, { type: 'ORDER_APPROVED', orderId: 'o1' }, 'corrected');
    expect(state.state).toBe('APPROVED');
    expect(transitions).toEqual(['APPROVED']);
    expect(commands.map((c) => `${c.type}->${c.to}`).sort()).toEqual([
      'ORDER_APPROVED->inventory',
      'ORDER_APPROVED->payment',
    ]);
  });

  it('transitions to FULFILLING only when both legs are ready, then requests capture (corrected)', () => {
    let s = initialCoordinatorState('o1', [{ sku: 'A', quantity: 1 }]);
    s = reduce(s, { type: 'ORDER_APPROVED', orderId: 'o1' }, 'corrected').state;
    s = reduce(s, { type: 'PAYMENT_AUTHORIZED', orderId: 'o1' }, 'corrected').state;
    expect(s.state).toBe('APPROVED'); // inventory not ready yet
    const r = reduce(s, { type: 'INVENTORY_RESERVED', orderId: 'o1' }, 'corrected');
    expect(r.state.state).toBe('FULFILLING');
    expect(r.state.fulfillCount).toBe(1);
    expect(r.commands).toEqual([{ type: 'CAPTURE_REQUESTED', to: 'payment', orderId: 'o1' }]);
  });

  it('does not request capture in the uncorrected design', () => {
    let s = initialCoordinatorState('o1', [{ sku: 'A', quantity: 1 }]);
    s = reduce(s, { type: 'ORDER_APPROVED', orderId: 'o1' }, 'uncorrected').state;
    s = reduce(s, { type: 'PAYMENT_AUTHORIZED', orderId: 'o1' }, 'uncorrected').state;
    const r = reduce(s, { type: 'INVENTORY_RESERVED', orderId: 'o1' }, 'uncorrected');
    expect(r.state.state).toBe('FULFILLING');
    expect(r.commands).toEqual([]);
  });

  it('emits compensation on failure only in the corrected design', () => {
    let s = initialCoordinatorState('o1', [{ sku: 'A', quantity: 1 }]);
    s = reduce(s, { type: 'ORDER_APPROVED', orderId: 'o1' }, 'corrected').state;
    const corrected = reduce(s, { type: 'PAYMENT_FAILED', orderId: 'o1' }, 'corrected');
    expect(corrected.state.state).toBe('CANCELLED');
    expect(corrected.commands.map((c) => `${c.type}->${c.to}`).sort()).toEqual([
      'ORDER_CANCELLED->inventory',
      'ORDER_CANCELLED->payment',
    ]);

    let u = initialCoordinatorState('o1', [{ sku: 'A', quantity: 1 }]);
    u = reduce(u, { type: 'ORDER_APPROVED', orderId: 'o1' }, 'uncorrected').state;
    const uncorrected = reduce(u, { type: 'PAYMENT_FAILED', orderId: 'o1' }, 'uncorrected');
    expect(uncorrected.state.state).toBe('CANCELLED');
    expect(uncorrected.commands).toEqual([]);
  });

  it('records every intermediate state on capture (FULFILLING -> SHIPPED -> COMPLETED)', () => {
    let s = initialCoordinatorState('o1', [{ sku: 'A', quantity: 1 }]);
    s = reduce(s, { type: 'ORDER_APPROVED', orderId: 'o1' }, 'corrected').state;
    s = reduce(s, { type: 'PAYMENT_AUTHORIZED', orderId: 'o1' }, 'corrected').state;
    s = reduce(s, { type: 'INVENTORY_RESERVED', orderId: 'o1' }, 'corrected').state;
    const r = reduce(s, { type: 'PAYMENT_CAPTURED', orderId: 'o1' }, 'corrected');
    expect(r.state.state).toBe('COMPLETED');
    expect(r.transitions).toEqual(['SHIPPED', 'COMPLETED']);
  });
});
