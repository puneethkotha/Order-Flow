/**
 * SagaCoordinator: the pure reducer at the centre of the design.
 *
 *   reduce(state, message, mode) -> { state, commands }
 *
 * It is deterministic and side-effect free. The runtime (order-service) turns
 * the returned commands into outbox writes; the property tests drive it with
 * randomized message orderings; the TLA+ spec mirrors each branch. This is the
 * single join point between "the model" and "the code".
 *
 * The `mode` flag selects between the two designs so one artifact can
 * demonstrate both the bug (uncorrected) and the fix (corrected):
 *
 *   uncorrected: no capture step; cancellation issues no compensation.
 *   corrected:   capture is issued on entry to FULFILLING and gated on it;
 *                cancellation issues void/refund and release commands.
 *
 * The read-modify-write race that strands a saga in APPROVED is an
 * interleaving property of the effectful runtime, not of this pure reducer;
 * it is reproduced separately with fc.scheduler over an async store.
 */

import {
  CoordinatorState,
  Message,
  OrderPhase,
  SagaMode,
  isLegalOrderEdge,
} from './types';

export interface ReduceResult {
  state: CoordinatorState;
  commands: EmitCommand[];
  /** Every state entered by this step, in order (for the monotonicity check). */
  transitions: OrderPhase[];
}

export interface EmitCommand {
  type: Message['type'];
  to: Message['to'];
  orderId: string;
}

export function initialCoordinatorState(
  orderId: string,
  items: CoordinatorState['items']
): CoordinatorState {
  return {
    orderId,
    state: 'DRAFT',
    items,
    paymentAuthorized: false,
    inventoryReserved: false,
    fulfillCount: 0,
    captureRequested: false,
    processed: [],
  };
}


/**
 * Apply one incoming message to the coordinator.
 *
 * Accepted message types:
 *  - ORDER_APPROVED (as the operator's approve command; DRAFT -> APPROVED)
 *  - PAYMENT_AUTHORIZED / INVENTORY_RESERVED (join fan-in)
 *  - PAYMENT_FAILED / INVENTORY_FAILED (compensation trigger)
 *  - PAYMENT_CAPTURED (drives fulfilment to a terminal success state)
 *  - ORDER_CANCELLED (operator-initiated cancel of a live order)
 */
export function reduce(
  input: CoordinatorState,
  message: Pick<Message, 'type' | 'orderId'>,
  mode: SagaMode
): ReduceResult {
  const state = { ...input };
  const commands: EmitCommand[] = [];
  const transitions: OrderPhase[] = [];

  const emit = (type: Message['type'], to: Message['to']) =>
    commands.push({ type, to, orderId: state.orderId });

  // Guard the legal DAG so the reducer can never record an illegal edge, and
  // capture every intermediate state entered by this step.
  const go = (to: OrderPhase): boolean => {
    if (!isLegalOrderEdge(state.state, to)) return false;
    state.state = to;
    transitions.push(to);
    return true;
  };

  switch (message.type) {
    case 'ORDER_APPROVED': {
      if (state.state === 'DRAFT' && go('APPROVED')) {
        // Fan out to the two independent participants.
        emit('ORDER_APPROVED', 'payment');
        emit('ORDER_APPROVED', 'inventory');
      }
      break;
    }

    case 'PAYMENT_AUTHORIZED': {
      state.paymentAuthorized = true;
      tryFulfil(state, mode, emit, go);
      break;
    }

    case 'INVENTORY_RESERVED': {
      state.inventoryReserved = true;
      tryFulfil(state, mode, emit, go);
      break;
    }

    case 'PAYMENT_FAILED':
    case 'INVENTORY_FAILED': {
      if ((state.state === 'APPROVED' || state.state === 'FULFILLING') && go('CANCELLED')) {
        if (mode === 'corrected') {
          // Compensate whatever the other leg already committed.
          emit('ORDER_CANCELLED', 'payment');
          emit('ORDER_CANCELLED', 'inventory');
        }
      }
      break;
    }

    case 'PAYMENT_CAPTURED': {
      // Only meaningful once fulfilling; drive to a terminal success state so
      // liveness (L1) has a concrete target. Each edge is legal and recorded.
      if (state.state === 'FULFILLING') {
        go('SHIPPED');
        go('COMPLETED');
      }
      break;
    }

    case 'ORDER_CANCELLED': {
      // Operator-initiated cancel of a live (non-terminal) order.
      if (
        (state.state === 'DRAFT' ||
          state.state === 'APPROVED' ||
          state.state === 'FULFILLING') &&
        go('CANCELLED')
      ) {
        if (mode === 'corrected') {
          emit('ORDER_CANCELLED', 'payment');
          emit('ORDER_CANCELLED', 'inventory');
        }
      }
      break;
    }

    default:
      break;
  }

  return { state, commands, transitions };
}

function tryFulfil(
  state: CoordinatorState,
  mode: SagaMode,
  emit: (type: Message['type'], to: Message['to']) => void,
  go: (to: OrderPhase) => boolean
): void {
  const canFulfil =
    state.state === 'APPROVED' &&
    state.paymentAuthorized &&
    state.inventoryReserved &&
    state.fulfillCount === 0;

  if (!canFulfil) {
    return;
  }

  if (go('FULFILLING')) {
    state.fulfillCount += 1;
    if (mode === 'corrected') {
      // Capture is only ever reachable from FULFILLING (both authorized and
      // reserved). This is what makes I1/I2 real rather than vacuous.
      state.captureRequested = true;
      emit('CAPTURE_REQUESTED', 'payment');
    }
  }
}
