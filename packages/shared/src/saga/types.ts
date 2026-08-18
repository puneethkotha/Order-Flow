/**
 * Shared value types for the saga model.
 *
 * These types are the single vocabulary used by:
 *  - the pure SagaCoordinator reducer (coordinator.ts),
 *  - the deterministic saga simulator (simulator.ts),
 *  - the invariant catalog (../invariants.ts),
 *  - the property-based tests, the chaos runner, and the trace viewer.
 *
 * Keeping one vocabulary is what lets the model, the tests, and the runtime
 * refer to the same states, events, and commands.
 */

export type OrderPhase =
  | 'DRAFT'
  | 'APPROVED'
  | 'FULFILLING'
  | 'SHIPPED'
  | 'COMPLETED'
  | 'CANCELLED';

/** Legal directed edges of the order state machine (used by invariant I8). */
export const LEGAL_ORDER_EDGES: ReadonlyArray<[OrderPhase, OrderPhase]> = [
  ['DRAFT', 'APPROVED'],
  ['APPROVED', 'FULFILLING'],
  ['APPROVED', 'CANCELLED'],
  ['FULFILLING', 'SHIPPED'],
  ['FULFILLING', 'CANCELLED'],
  ['SHIPPED', 'COMPLETED'],
  ['DRAFT', 'CANCELLED'],
];

export function isLegalOrderEdge(from: OrderPhase, to: OrderPhase): boolean {
  return LEGAL_ORDER_EDGES.some(([a, b]) => a === from && b === to);
}

export type PaymentPhase =
  | 'NONE'
  | 'AUTHORIZED'
  | 'CAPTURED'
  | 'VOIDED'
  | 'REFUNDED'
  | 'FAILED';

export type ReservationPhase = 'NONE' | 'RESERVED' | 'RELEASED' | 'FAILED';

/** Participants that receive messages on the (unordered, duplicating) channel. */
export type Participant = 'coordinator' | 'payment' | 'inventory';

export type MessageType =
  // Coordinator -> participants
  | 'ORDER_APPROVED'
  | 'ORDER_CANCELLED'
  | 'CAPTURE_REQUESTED'
  // Payment -> coordinator
  | 'PAYMENT_AUTHORIZED'
  | 'PAYMENT_FAILED'
  | 'PAYMENT_CAPTURED'
  | 'PAYMENT_VOIDED'
  | 'PAYMENT_REFUNDED'
  // Inventory -> coordinator
  | 'INVENTORY_RESERVED'
  | 'INVENTORY_FAILED'
  | 'INVENTORY_RELEASED';

export interface LineItem {
  sku: string;
  quantity: number;
}

/**
 * A message in flight on the channel. `eventId` is the business identity that
 * survives re-publication (the correct idempotency key). `seq` is the delivery
 * offset that changes on every (re)delivery (the broken idempotency key that
 * the uncorrected design uses). The gap between the two is the source of the
 * duplicate-processing defect.
 */
export interface Message {
  seq: number;
  eventId: string;
  type: MessageType;
  orderId: string;
  to: Participant;
  items?: LineItem[];
}

/** Coordinator (order-service) per-order state. Mirrors order_state_tracking. */
export interface CoordinatorState {
  orderId: string;
  state: OrderPhase;
  items: LineItem[];
  paymentAuthorized: boolean;
  inventoryReserved: boolean;
  fulfillCount: number;
  captureRequested: boolean;
  processed: string[];
}

/** Payment-service per-order state, including the compensation ledger facts. */
export interface PaymentState {
  orderId: string;
  phase: PaymentPhase;
  authorized: boolean;
  captured: boolean;
  voided: boolean;
  refunded: boolean;
  failed: boolean;
  /** Set when a cancel is observed; blocks authorizing after cancellation. */
  cancelled: boolean;
  processed: string[];
}

/** Inventory-service per-order reservation state. */
export interface ReservationState {
  orderId: string;
  phase: ReservationPhase;
  reservedQty: number;
  reservedEver: boolean;
  released: boolean;
  failed: boolean;
  /** Set when a cancel is observed; blocks reserving after cancellation. */
  cancelled: boolean;
  processed: string[];
}

/** Physical stock per SKU. `reserved` is the sum of active reservations. */
export interface StockLevel {
  sku: string;
  physical: number;
  reserved: number;
}

/**
 * A complete snapshot of the saga world. Invariants are total predicates over
 * this structure. The trace viewer renders a sequence of these snapshots.
 */
export interface SagaWorld {
  orders: Record<string, CoordinatorState>;
  payments: Record<string, PaymentState>;
  reservations: Record<string, ReservationState>;
  stock: Record<string, StockLevel>;
  /** Per-order ordered history of order states, for the monotonicity check. */
  history: Record<string, OrderPhase[]>;
}

export type SagaMode = 'uncorrected' | 'corrected';

/** Commands returned by the pure coordinator reducer. */
export type CoordinatorCommand =
  | { type: 'EMIT'; message: Omit<Message, 'seq' | 'eventId'> }
  | { type: 'NONE' };
