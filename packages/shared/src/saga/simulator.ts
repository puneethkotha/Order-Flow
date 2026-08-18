/**
 * A deterministic, single-process saga simulator.
 *
 * It wires the pure coordinator reducer to payment and inventory participants
 * over an unordered, duplicating, lossy channel (a multiset of in-flight
 * messages). It is fully deterministic given a seed, so the same run can be
 * driven by the property tests, replayed by the chaos runner, and rendered by
 * the trace viewer. It intentionally models the *message layer* faults
 * (duplicate, reorder, drop, crash-redeliver); the intra-process read-modify
 * -write race is reproduced separately with fc.scheduler.
 *
 * Two designs live behind one `mode` flag:
 *   uncorrected: no capture; no compensation; dedup keyed on delivery offset.
 *   corrected:   capture gated on FULFILLING; compensation on cancel; dedup
 *                keyed on business eventId.
 */

import {
  CoordinatorState,
  LineItem,
  Message,
  MessageType,
  OrderPhase,
  SagaMode,
  SagaWorld,
  StockLevel,
} from './types';
import { reduce, initialCoordinatorState } from './coordinator';
import {
  InvariantReport,
  checkSafety,
  checkAll,
  firstStepSafetyViolation,
  firstEventualSafetyViolation,
} from '../invariants';

export type FaultKind = 'duplicate' | 'reorder' | 'drop' | 'crash';

export interface TraceStep {
  index: number;
  action: string;
  message?: { type: MessageType; to: Message['to']; orderId: string; seq: number };
  fault?: FaultKind;
  world: SagaWorld;
  safety: InvariantReport[];
}

export interface TraceBundle {
  meta: {
    mode: SagaMode;
    seed: number;
    orders: number;
    scenario?: string;
    faults?: FaultKind[];
    generatedAt: string;
  };
  steps: TraceStep[];
  finalSafety: InvariantReport[];
  liveness: InvariantReport[];
  ok: boolean;
}

/** Small, fast, seedable PRNG (mulberry32). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface SimulatorOptions {
  mode: SagaMode;
  stock?: Record<string, number>;
  /** 0..1 probability that a payment authorization succeeds. Default 1. */
  paymentSuccessRate?: number;
  seed?: number;
}

export class SagaSimulator {
  readonly mode: SagaMode;
  private world: SagaWorld;
  private channel: Message[] = [];
  private seq = 0;
  private eventCounter = 0;
  private rng: () => number;
  private paymentSuccessRate: number;

  constructor(opts: SimulatorOptions) {
    this.mode = opts.mode;
    this.paymentSuccessRate = opts.paymentSuccessRate ?? 1;
    this.rng = mulberry32(opts.seed ?? 1);
    const stock: Record<string, StockLevel> = {};
    for (const [sku, physical] of Object.entries(opts.stock ?? {})) {
      stock[sku] = { sku, physical, reserved: 0 };
    }
    this.world = {
      orders: {},
      payments: {},
      reservations: {},
      stock,
      history: {},
    };
  }

  /** Register an order in DRAFT. */
  createOrder(orderId: string, items: LineItem[]): void {
    this.world.orders[orderId] = initialCoordinatorState(orderId, items);
    this.world.payments[orderId] = {
      orderId,
      phase: 'NONE',
      authorized: false,
      captured: false,
      voided: false,
      refunded: false,
      failed: false,
      cancelled: false,
      processed: [],
    };
    this.world.reservations[orderId] = {
      orderId,
      phase: 'NONE',
      reservedQty: 0,
      reservedEver: false,
      released: false,
      failed: false,
      cancelled: false,
      processed: [],
    };
    this.world.history[orderId] = ['DRAFT'];
  }

  /** Approve an order: DRAFT -> APPROVED and fan out ORDER_APPROVED. */
  approveOrder(orderId: string): void {
    this.deliverToCoordinator({ type: 'ORDER_APPROVED', orderId });
  }

  /** Operator-initiated cancel of a live order. */
  cancelOrder(orderId: string): void {
    this.deliverToCoordinator({ type: 'ORDER_CANCELLED', orderId });
  }

  pending(): Message[] {
    return [...this.channel];
  }

  isQuiescent(): boolean {
    return this.channel.length === 0;
  }

  snapshot(): SagaWorld {
    return structuredClone(this.world);
  }

  safetyReport(): InvariantReport[] {
    return checkSafety(this.world);
  }

  private nextEventId(type: MessageType, orderId: string): string {
    this.eventCounter += 1;
    return `${type}:${orderId}:${this.eventCounter}`;
  }

  private enqueue(
    partial: { type: MessageType; to: Message['to']; orderId: string; items?: LineItem[] },
    eventId?: string
  ): void {
    this.seq += 1;
    this.channel.push({
      seq: this.seq,
      eventId: eventId ?? this.nextEventId(partial.type, partial.orderId),
      type: partial.type,
      to: partial.to,
      orderId: partial.orderId,
      items: partial.items,
    });
  }

  /** Deliver a synthetic message straight to the coordinator (approve/cancel). */
  private deliverToCoordinator(msg: { type: MessageType; orderId: string }): void {
    const before = this.world.orders[msg.orderId];
    if (!before) return;
    const { state, commands, transitions } = reduce(before, msg, this.mode);
    this.applyCoordinatorState(msg.orderId, state, transitions);
    for (const cmd of commands) {
      const items = this.world.orders[cmd.orderId]?.items;
      this.enqueue({ type: cmd.type, to: cmd.to, orderId: cmd.orderId, items });
    }
  }

  private applyCoordinatorState(
    orderId: string,
    next: CoordinatorState,
    transitions: OrderPhase[]
  ): void {
    this.world.orders[orderId] = next;
    for (const phase of transitions) {
      this.world.history[orderId].push(phase);
    }
  }

  /** The dedup key for a recipient, per design. */
  private dedupKey(msg: Message): string {
    return this.mode === 'corrected' ? msg.eventId : `seq:${msg.seq}`;
  }

  private processCoordinator(msg: Message): void {
    const state = this.world.orders[msg.orderId];
    if (!state) return;
    const key = this.dedupKey(msg);
    if (state.processed.includes(key)) return;
    state.processed.push(key);
    const { state: next, commands, transitions } = reduce(state, msg, this.mode);
    this.applyCoordinatorState(msg.orderId, next, transitions);
    for (const cmd of commands) {
      const items = this.world.orders[cmd.orderId]?.items;
      this.enqueue({ type: cmd.type, to: cmd.to, orderId: cmd.orderId, items });
    }
  }

  private processPayment(msg: Message): void {
    const payment = this.world.payments[msg.orderId];
    if (!payment) return;
    const key = this.dedupKey(msg);
    if (payment.processed.includes(key)) return;
    payment.processed.push(key);

    switch (msg.type) {
      case 'ORDER_APPROVED': {
        // Idempotent by identity of the order (mirrors idempotencyKey on the
        // authorize call): a payment decision is made at most once per order.
        // If a cancel was already observed (reordered ahead), do not authorize.
        if (payment.phase !== 'NONE' || payment.cancelled) return;
        const success = this.rng() < this.paymentSuccessRate;
        if (success) {
          payment.authorized = true;
          payment.phase = 'AUTHORIZED';
          this.enqueue({ type: 'PAYMENT_AUTHORIZED', to: 'coordinator', orderId: msg.orderId });
        } else {
          payment.failed = true;
          payment.phase = 'FAILED';
          this.enqueue({ type: 'PAYMENT_FAILED', to: 'coordinator', orderId: msg.orderId });
        }
        break;
      }
      case 'CAPTURE_REQUESTED': {
        if (payment.authorized && !payment.captured) {
          payment.captured = true;
          payment.phase = 'CAPTURED';
          this.enqueue({ type: 'PAYMENT_CAPTURED', to: 'coordinator', orderId: msg.orderId });
        }
        break;
      }
      case 'ORDER_CANCELLED': {
        payment.cancelled = true;
        if (payment.captured && !payment.refunded) {
          payment.refunded = true;
          payment.phase = 'REFUNDED';
        } else if (payment.authorized && !payment.voided && !payment.captured) {
          payment.voided = true;
          payment.phase = 'VOIDED';
        }
        break;
      }
      default:
        break;
    }
  }

  private processInventory(msg: Message): void {
    const res = this.world.reservations[msg.orderId];
    const order = this.world.orders[msg.orderId];
    if (!res || !order) return;
    const key = this.dedupKey(msg);
    if (res.processed.includes(key)) return;
    res.processed.push(key);

    switch (msg.type) {
      case 'ORDER_APPROVED': {
        // If a cancel was already observed (reordered ahead of the approve),
        // do not reserve: the corrected design must tolerate compensation that
        // arrives before the forward action.
        if (res.cancelled) return;
        // No business-level idempotency here: the reservation is redone every
        // time this message is processed. Only the dedup key protects it, so a
        // re-delivered ORDER_APPROVED double-reserves under the uncorrected
        // (offset-keyed) design.
        let canReserveAll = true;
        for (const item of order.items) {
          const level = this.world.stock[item.sku];
          const available = level ? level.physical - level.reserved : 0;
          if (available < item.quantity) {
            canReserveAll = false;
            break;
          }
        }
        if (canReserveAll) {
          for (const item of order.items) {
            const level = this.world.stock[item.sku];
            if (level) level.reserved += item.quantity;
            res.reservedQty += item.quantity;
          }
          res.reservedEver = true;
          res.phase = 'RESERVED';
          this.enqueue({ type: 'INVENTORY_RESERVED', to: 'coordinator', orderId: msg.orderId });
        } else {
          res.failed = true;
          res.phase = 'FAILED';
          this.enqueue({ type: 'INVENTORY_FAILED', to: 'coordinator', orderId: msg.orderId });
        }
        break;
      }
      case 'ORDER_CANCELLED': {
        res.cancelled = true;
        if (res.reservedQty > 0) {
          for (const item of order.items) {
            const level = this.world.stock[item.sku];
            if (level) level.reserved -= item.quantity;
          }
          res.reservedQty = 0;
          res.released = true;
          res.phase = 'RELEASED';
        }
        break;
      }
      default:
        break;
    }
  }

  private dispatch(msg: Message): void {
    if (msg.to === 'coordinator') this.processCoordinator(msg);
    else if (msg.to === 'payment') this.processPayment(msg);
    else this.processInventory(msg);
  }

  /** Deliver the message at `index` in the channel. Returns the delivered message. */
  deliver(index: number): Message {
    const [msg] = this.channel.splice(index, 1);
    this.dispatch(msg);
    return msg;
  }

  /** Re-enqueue a copy of a pending message with a fresh delivery offset. */
  duplicate(index: number): Message {
    const msg = this.channel[index];
    this.seq += 1;
    this.channel.push({ ...msg, seq: this.seq });
    return msg;
  }

  /**
   * Crash-redeliver: process the message but keep it in the channel so it is
   * delivered again (models a crash after the effect commits but before the
   * offset/mark is recorded).
   */
  crashRedeliver(index: number): Message {
    const msg = this.channel[index];
    this.dispatch(msg);
    this.seq += 1;
    this.channel.push({ ...msg, seq: this.seq });
    this.channel.splice(index, 1);
    return msg;
  }

  /**
   * One scheduling step: apply an optional fault then deliver a message.
   * Returns a short description of what happened, or null when quiescent.
   * Shared by the trace-producing run() and the allocation-free runChecked().
   */
  private stepOnce(faults: FaultKind[]): { action: string; fault?: FaultKind } | null {
    if (this.isQuiescent()) return null;
    const n = this.channel.length;
    const pick = faults.includes('reorder') && n > 1 ? Math.floor(this.rng() * n) : 0;

    if (faults.includes('duplicate') && this.channel.length > 0 && this.rng() < 0.25) {
      const dupPick = Math.floor(this.rng() * this.channel.length);
      const dup = this.duplicate(dupPick);
      return { action: `duplicate ${dup.type}->${dup.to}`, fault: 'duplicate' };
    }

    if (faults.includes('drop') && this.channel.length > 1 && this.rng() < 0.15) {
      const dropPick = Math.floor(this.rng() * this.channel.length);
      const candidate = this.channel[dropPick];
      const copies = this.channel.filter((m) => m.eventId === candidate.eventId).length;
      if (copies > 1) {
        const dropped = this.channel.splice(dropPick, 1)[0];
        return { action: `drop ${dropped.type}->${dropped.to}`, fault: 'drop' };
      }
    }

    if (faults.includes('crash') && this.rng() < 0.1) {
      const delivered = this.crashRedeliver(pick);
      return { action: `crash-redeliver ${delivered.type}->${delivered.to}`, fault: 'crash' };
    }

    const delivered = this.deliver(pick);
    return { action: `deliver ${delivered.type}->${delivered.to}` };
  }

  /**
   * Allocation-free run: deliver to quiescence with faults, checking safety on
   * the live world after every step. Returns the first safety violation seen
   * (or null) and the liveness report at quiescence. Used by the property
   * tests where 1e5 sequences make per-step snapshots too expensive.
   */
  runChecked(opts: { faults?: FaultKind[]; maxSteps?: number } = {}): {
    safetyViolation: InvariantReport | null;
    liveness: InvariantReport[];
    steps: number;
  } {
    const faults = opts.faults ?? [];
    const maxSteps = opts.maxSteps ?? 4000;
    let steps = 0;
    // Step-safety invariants (I1, I2, I6, I7, I8) must hold after every step.
    let violation = firstStepSafetyViolation(this.world);
    while (!violation && !this.isQuiescent() && steps < maxSteps) {
      this.stepOnce(faults);
      steps += 1;
      violation = firstStepSafetyViolation(this.world);
    }
    // At quiescence, the eventual-safety invariants (I3, I4, I5) must also hold:
    // all compensation has now drained from the channel.
    if (!violation && this.isQuiescent()) {
      violation = firstEventualSafetyViolation(this.world);
    }
    const liveness = checkAll(this.world).filter((r) => r.kind === 'liveness');
    return { safetyViolation: violation, liveness, steps };
  }

  /**
   * Run to quiescence with optional seeded fault injection. Records a trace.
   */
  run(opts: { faults?: FaultKind[]; seed?: number; maxSteps?: number; scenario?: string } = {}): TraceBundle {
    const faults = opts.faults ?? [];
    const maxSteps = opts.maxSteps ?? 2000;
    const steps: TraceStep[] = [];
    let index = 0;

    // Record the starting point.
    steps.push({
      index: index++,
      action: 'start',
      world: this.snapshot(),
      safety: this.safetyReport(),
    });

    while (!this.isQuiescent() && index < maxSteps) {
      const n = this.channel.length;
      // Pick a delivery position. Reorder fault picks a random pending message
      // instead of the head; otherwise FIFO-ish head delivery.
      const pick =
        faults.includes('reorder') && n > 1 ? Math.floor(this.rng() * n) : 0;

      // Duplicate fault: occasionally re-enqueue before delivering.
      if (faults.includes('duplicate') && n > 0 && this.rng() < 0.25) {
        const dupPick = Math.floor(this.rng() * this.channel.length);
        const dup = this.duplicate(dupPick);
        steps.push({
          index: index++,
          action: `duplicate ${dup.type}->${dup.to}`,
          fault: 'duplicate',
          world: this.snapshot(),
          safety: this.safetyReport(),
        });
      }

      // Drop fault: occasionally drop a message. Applied only to compensation-
      // irrelevant redeliverable messages would be unfair, so we drop only
      // duplicates by never dropping the last remaining copy of an eventId.
      if (faults.includes('drop') && this.channel.length > 1 && this.rng() < 0.15) {
        const dropPick = Math.floor(this.rng() * this.channel.length);
        const candidate = this.channel[dropPick];
        const copies = this.channel.filter((m) => m.eventId === candidate.eventId).length;
        if (copies > 1) {
          const dropped = this.channel.splice(dropPick, 1)[0];
          steps.push({
            index: index++,
            action: `drop ${dropped.type}->${dropped.to}`,
            fault: 'drop',
            world: this.snapshot(),
            safety: this.safetyReport(),
          });
          continue;
        }
      }

      let delivered: Message;
      if (faults.includes('crash') && this.rng() < 0.1) {
        delivered = this.crashRedeliver(pick);
        steps.push({
          index: index++,
          action: `crash-redeliver ${delivered.type}->${delivered.to}`,
          fault: 'crash',
          message: {
            type: delivered.type,
            to: delivered.to,
            orderId: delivered.orderId,
            seq: delivered.seq,
          },
          world: this.snapshot(),
          safety: this.safetyReport(),
        });
      } else {
        delivered = this.deliver(pick);
        steps.push({
          index: index++,
          action: `deliver ${delivered.type}->${delivered.to}`,
          message: {
            type: delivered.type,
            to: delivered.to,
            orderId: delivered.orderId,
            seq: delivered.seq,
          },
          world: this.snapshot(),
          safety: this.safetyReport(),
        });
      }
    }

    const liveness = checkAll(this.snapshot()).filter((r) => r.kind === 'liveness');
    const finalSafety = this.safetyReport();
    const ok = finalSafety.every((r) => r.holds) && liveness.every((r) => r.holds);

    return {
      meta: {
        mode: this.mode,
        seed: opts.seed ?? 0,
        orders: Object.keys(this.world.orders).length,
        scenario: opts.scenario,
        faults,
        generatedAt: new Date().toISOString(),
      },
      steps,
      finalSafety,
      liveness,
      ok,
    };
  }
}
