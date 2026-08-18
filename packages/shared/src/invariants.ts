/**
 * The invariant catalog.
 *
 * Each entry is a total predicate over a SagaWorld snapshot (plus, for the
 * monotonicity invariant, the per-order state history the world already
 * carries). The same catalog is consumed by:
 *  - the property-based tests (assert after every generated command),
 *  - the chaos runner (assert after draining each scenario),
 *  - the spec map (each invariant is an INVARIANT in the TLA+ model),
 *  - the trace viewer (renders one status row per invariant id).
 *
 * There are 8 safety invariants (I1-I8) and 1 liveness invariant (L1).
 * L1 is temporal and cannot be decided from a single snapshot; its
 * predicate is evaluated only against a *quiescent* world (no messages left
 * to deliver), which is exactly how the tests and chaos runner use it.
 */

import { SagaWorld, isLegalOrderEdge } from './saga/types';

export type InvariantKind = 'safety' | 'liveness';

/**
 * When an invariant is expected to hold:
 *  - 'step': must hold after every single step (a true state invariant).
 *  - 'eventual': holds once the system is quiescent. Compensation-completion
 *    properties are eventual: between a cancel and the delivery of its
 *    compensation there is a legitimate in-flight window in which stock is
 *    still reserved / an authorization is still live.
 */
export type InvariantTiming = 'step' | 'eventual';

export interface InvariantResult {
  holds: boolean;
  /** Empty when holds is true; one human-readable line per violating order/sku. */
  violations: string[];
}

export interface Invariant {
  id: string;
  title: string;
  kind: InvariantKind;
  timing: InvariantTiming;
  statement: string;
  check(world: SagaWorld): InvariantResult;
}

function result(violations: string[]): InvariantResult {
  return { holds: violations.length === 0, violations };
}

const isTerminalCancelled = (state: string): boolean => state === 'CANCELLED';

export const INVARIANTS: Invariant[] = [
  {
    id: 'I1',
    title: 'Capture implies reserve',
    kind: 'safety',
    timing: 'step',
    statement: 'paymentCaptured(o) => inventoryReserved(o)',
    check(world) {
      const violations: string[] = [];
      for (const [orderId, payment] of Object.entries(world.payments)) {
        if (payment.captured) {
          const res = world.reservations[orderId];
          if (!res || !res.reservedEver) {
            violations.push(`${orderId}: captured without an inventory reservation`);
          }
        }
      }
      return result(violations);
    },
  },
  {
    id: 'I2',
    title: 'Capture implies authorize',
    kind: 'safety',
    timing: 'step',
    statement: 'paymentCaptured(o) => paymentAuthorized(o)',
    check(world) {
      const violations: string[] = [];
      for (const [orderId, payment] of Object.entries(world.payments)) {
        if (payment.captured && !payment.authorized) {
          violations.push(`${orderId}: captured without authorization`);
        }
      }
      return result(violations);
    },
  },
  {
    id: 'I3',
    title: 'Funds safety',
    kind: 'safety',
    timing: 'eventual',
    statement: 'orderCancelled(o) => !paymentCaptured(o) || paymentRefunded(o)',
    check(world) {
      const violations: string[] = [];
      for (const [orderId, order] of Object.entries(world.orders)) {
        if (order.state !== 'CANCELLED') continue;
        const payment = world.payments[orderId];
        if (payment && payment.captured && !payment.refunded) {
          violations.push(`${orderId}: cancelled while captured and not refunded`);
        }
      }
      return result(violations);
    },
  },
  {
    id: 'I4',
    title: 'No stock leak',
    kind: 'safety',
    timing: 'eventual',
    statement: 'terminalCancelled(o) => reservedFor(o) = 0',
    check(world) {
      const violations: string[] = [];
      for (const [orderId, order] of Object.entries(world.orders)) {
        if (!isTerminalCancelled(order.state)) continue;
        const res = world.reservations[orderId];
        if (res && res.reservedQty !== 0) {
          violations.push(
            `${orderId}: cancelled but still holds ${res.reservedQty} reserved units`
          );
        }
      }
      return result(violations);
    },
  },
  {
    id: 'I5',
    title: 'No held authorization',
    kind: 'safety',
    timing: 'eventual',
    statement: 'terminalCancelled(o) => authorizationVoided(o) || !paymentAuthorized(o)',
    check(world) {
      const violations: string[] = [];
      for (const [orderId, order] of Object.entries(world.orders)) {
        if (!isTerminalCancelled(order.state)) continue;
        const payment = world.payments[orderId];
        if (!payment) continue;
        const held = payment.authorized && !payment.voided && !payment.refunded;
        if (held) {
          violations.push(`${orderId}: cancelled but authorization still live`);
        }
      }
      return result(violations);
    },
  },
  {
    id: 'I6',
    title: 'Single fulfillment',
    kind: 'safety',
    timing: 'step',
    statement: 'at most one FULFILLING transition per order',
    check(world) {
      const violations: string[] = [];
      for (const [orderId, order] of Object.entries(world.orders)) {
        if (order.fulfillCount > 1) {
          violations.push(`${orderId}: entered FULFILLING ${order.fulfillCount} times`);
        }
      }
      return result(violations);
    },
  },
  {
    id: 'I7',
    title: 'Inventory conservation',
    kind: 'safety',
    timing: 'step',
    statement: 'stock.reserved(sku) = sum of active reservations(sku) and 0 <= reserved <= physical',
    check(world) {
      const violations: string[] = [];
      const reservedBySku: Record<string, number> = {};
      for (const res of Object.values(world.reservations)) {
        if (res.reservedQty <= 0) continue;
        // A reservation covers exactly one order; attribute it to that order's items.
        const order = world.orders[res.orderId];
        if (!order) continue;
        for (const item of order.items) {
          reservedBySku[item.sku] = (reservedBySku[item.sku] || 0) + item.quantity;
        }
      }
      for (const [sku, level] of Object.entries(world.stock)) {
        const expected = reservedBySku[sku] || 0;
        if (level.reserved !== expected) {
          violations.push(
            `${sku}: stock.reserved=${level.reserved} but active reservations sum to ${expected}`
          );
        }
        if (level.reserved < 0 || level.reserved > level.physical) {
          violations.push(
            `${sku}: reserved=${level.reserved} out of bounds [0, ${level.physical}]`
          );
        }
      }
      return result(violations);
    },
  },
  {
    id: 'I8',
    title: 'Monotonic state',
    kind: 'safety',
    timing: 'step',
    statement: 'order state only advances along the legal DAG',
    check(world) {
      const violations: string[] = [];
      for (const [orderId, history] of Object.entries(world.history)) {
        for (let i = 1; i < history.length; i++) {
          if (!isLegalOrderEdge(history[i - 1], history[i])) {
            violations.push(`${orderId}: illegal edge ${history[i - 1]} -> ${history[i]}`);
          }
        }
      }
      return result(violations);
    },
  },
  {
    id: 'L1',
    title: 'Eventual resolution',
    kind: 'liveness',
    timing: 'eventual',
    statement: 'every order eventually reaches COMPLETED or a clean CANCELLED (evaluated at quiescence)',
    check(world) {
      const violations: string[] = [];
      for (const [orderId, order] of Object.entries(world.orders)) {
        const resolved = order.state === 'COMPLETED' || order.state === 'CANCELLED';
        if (!resolved) {
          violations.push(`${orderId}: stuck in ${order.state} at quiescence`);
        }
      }
      return result(violations);
    },
  },
];

export const SAFETY_INVARIANTS = INVARIANTS.filter((i) => i.kind === 'safety');
export const LIVENESS_INVARIANTS = INVARIANTS.filter((i) => i.kind === 'liveness');
export const STEP_SAFETY_INVARIANTS = SAFETY_INVARIANTS.filter((i) => i.timing === 'step');
export const EVENTUAL_SAFETY_INVARIANTS = SAFETY_INVARIANTS.filter((i) => i.timing === 'eventual');

export interface InvariantReport {
  id: string;
  title: string;
  kind: InvariantKind;
  timing: InvariantTiming;
  holds: boolean;
  violations: string[];
}

function toReport(inv: Invariant, world: SagaWorld): InvariantReport {
  return {
    id: inv.id,
    title: inv.title,
    kind: inv.kind,
    timing: inv.timing,
    ...inv.check(world),
  };
}

function firstViolation(invs: Invariant[], world: SagaWorld): InvariantReport | null {
  for (const inv of invs) {
    const res = inv.check(world);
    if (!res.holds) return { ...toReport(inv, world), ...res };
  }
  return null;
}

/** Check every safety invariant against a snapshot (step + eventual). */
export function checkSafety(world: SagaWorld): InvariantReport[] {
  return SAFETY_INVARIANTS.map((inv) => toReport(inv, world));
}

/** Check all invariants (including liveness); use only at quiescence. */
export function checkAll(world: SagaWorld): InvariantReport[] {
  return INVARIANTS.map((inv) => toReport(inv, world));
}

/** The first safety invariant of any timing that fails, or null. */
export function firstSafetyViolation(world: SagaWorld): InvariantReport | null {
  return firstViolation(SAFETY_INVARIANTS, world);
}

/** The first step-safety invariant that fails; safe to call after every step. */
export function firstStepSafetyViolation(world: SagaWorld): InvariantReport | null {
  return firstViolation(STEP_SAFETY_INVARIANTS, world);
}

/** The first eventual-safety invariant that fails; call only at quiescence. */
export function firstEventualSafetyViolation(world: SagaWorld): InvariantReport | null {
  return firstViolation(EVENTUAL_SAFETY_INVARIANTS, world);
}
