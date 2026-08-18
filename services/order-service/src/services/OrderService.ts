import { PoolClient } from 'pg';
import { OrderAggregate } from '../domain/OrderAggregate';
import { OrderRepository } from '../repositories/OrderRepository';
import { OutboxRepository } from '../repositories/OutboxRepository';
import { EventRepository } from '../repositories/EventRepository';
import { StateTrackingRepository } from '../repositories/StateTrackingRepository';
import { IdempotencyRepository } from '../repositories/IdempotencyRepository';
import { db } from '../db/client';
import { v4 as uuidv4 } from 'uuid';
import {
  OrderCreatedEvent,
  OrderApprovedEvent,
  OrderStateChangedEvent,
  OrderCancelledEvent,
  CaptureRequestedEvent,
  Topics,
  EventTypes,
  OrderItem,
} from '@orderflow/shared';
import { logger } from '../utils/logger';
import { ordersCreated, ordersFulfilling, ordersCancelled } from '../metrics';

export class OrderService {
  constructor(
    private orderRepo: OrderRepository,
    private outboxRepo: OutboxRepository,
    private eventRepo: EventRepository,
    private stateTrackingRepo: StateTrackingRepository,
    private idempotencyRepo: IdempotencyRepository
  ) {}

  async createOrder(customerId: string, items: OrderItem[], correlationId?: string): Promise<OrderAggregate> {
    const order = OrderAggregate.create(customerId, items);
    const corrId = correlationId || uuidv4();

    await db.transaction(async (client) => {
      await this.orderRepo.save(order, client);

      const event: OrderCreatedEvent = {
        eventId: uuidv4(),
        eventType: EventTypes.ORDER_CREATED,
        aggregateId: order.id,
        timestamp: new Date().toISOString(),
        correlationId: corrId,
        version: order.version,
        payload: {
          orderId: order.id,
          customerId: order.customerId,
          items: order.items,
          total: order.total,
        },
      };

      await this.eventRepo.save(order.id, EventTypes.ORDER_CREATED, event.payload, client);
      await this.outboxRepo.save(order.id, Topics.ORDER_EVENTS, order.id, event, client);
    });

    ordersCreated.inc();
    logger.info({ orderId: order.id, correlationId: corrId }, 'Order created');
    return order;
  }

  async approveOrder(orderId: string, correlationId?: string): Promise<void> {
    const corrId = correlationId || uuidv4();

    await db.transaction(async (client) => {
      const order = await this.orderRepo.findById(orderId, client);
      if (!order) {
        throw new Error(`Order ${orderId} not found`);
      }

      order.approve();
      await this.orderRepo.save(order, client);
      await this.stateTrackingRepo.upsert(orderId, client);

      const event: OrderApprovedEvent = {
        eventId: uuidv4(),
        eventType: EventTypes.ORDER_APPROVED,
        aggregateId: order.id,
        timestamp: new Date().toISOString(),
        correlationId: corrId,
        version: order.version,
        payload: {
          orderId: order.id,
          customerId: order.customerId,
          total: order.total,
          items: order.items,
        },
      };

      await this.eventRepo.save(order.id, EventTypes.ORDER_APPROVED, event.payload, client);
      await this.outboxRepo.save(order.id, Topics.ORDER_EVENTS, order.id, event, client);
    });

    logger.info({ orderId, correlationId: corrId }, 'Order approved');
  }

  async handlePaymentAuthorized(orderId: string, eventId: string, correlationId: string): Promise<void> {
    await db.transaction(async (client) => {
      if (!(await this.idempotencyRepo.claim(eventId, client))) return;
      await this.stateTrackingRepo.updatePaymentStatus(orderId, true, client);
      await this.tryTransitionToFulfilling(orderId, correlationId, client);
    });
  }

  async handlePaymentFailed(orderId: string, reason: string, eventId: string, correlationId: string): Promise<void> {
    await db.transaction(async (client) => {
      if (!(await this.idempotencyRepo.claim(eventId, client))) return;
      await this.cancelInTransaction(client, orderId, reason, 'PAYMENT_FAILED', correlationId);
    });
  }

  async handleInventoryReserved(orderId: string, eventId: string, correlationId: string): Promise<void> {
    await db.transaction(async (client) => {
      if (!(await this.idempotencyRepo.claim(eventId, client))) return;
      await this.stateTrackingRepo.updateInventoryStatus(orderId, true, client);
      await this.tryTransitionToFulfilling(orderId, correlationId, client);
    });
  }

  async handleInventoryFailed(orderId: string, reason: string, eventId: string, correlationId: string): Promise<void> {
    await db.transaction(async (client) => {
      if (!(await this.idempotencyRepo.claim(eventId, client))) return;
      await this.cancelInTransaction(client, orderId, reason, 'INVENTORY_FAILED', correlationId);
    });
  }

  /** Record that payment was captured (ack of the coordinator's CAPTURE_REQUESTED). */
  async handlePaymentCaptured(orderId: string, eventId: string, correlationId: string): Promise<void> {
    await db.transaction(async (client) => {
      if (!(await this.idempotencyRepo.claim(eventId, client))) return;
      await this.stateTrackingRepo.updatePaymentCaptured(orderId, true, client);
    });
    logger.info({ orderId, correlationId }, 'Payment captured recorded');
  }

  /** Record a compensation acknowledgement so duplicates are deduplicated. */
  async handleCompensationAck(orderId: string, eventType: string, eventId: string, correlationId: string): Promise<void> {
    await db.transaction(async (client) => {
      if (!(await this.idempotencyRepo.claim(eventId, client))) return;
    });
    logger.info({ orderId, eventType, correlationId }, 'Compensation acknowledgement recorded');
  }

  /**
   * The join. Reads the order and tracking row THROUGH the transaction client,
   * taking SELECT ... FOR UPDATE on the tracking row so the two coordinator
   * handlers serialize and each observes the other's committed write. On
   * transition to FULFILLING it issues CAPTURE_REQUESTED, the only path by which
   * a capture can occur -- which is what makes "captured implies reserved" real.
   */
  private async tryTransitionToFulfilling(orderId: string, correlationId: string, client: PoolClient): Promise<void> {
    const order = await this.orderRepo.findById(orderId, client);
    if (!order) {
      throw new Error(`Order ${orderId} not found`);
    }

    const tracking = await this.stateTrackingRepo.findByOrderIdForUpdate(orderId, client);
    if (!tracking) {
      logger.warn({ orderId }, 'State tracking not found');
      return;
    }

    if (!order.canTransitionToFulfilling(tracking.paymentAuthorized, tracking.inventoryReserved)) {
      return;
    }

    order.startFulfilling();
    await this.orderRepo.save(order, client);

    const stateEvent: OrderStateChangedEvent = {
      eventId: uuidv4(),
      eventType: EventTypes.ORDER_STATE_CHANGED,
      aggregateId: order.id,
      timestamp: new Date().toISOString(),
      correlationId,
      version: order.version,
      payload: { orderId: order.id, previousState: 'APPROVED', newState: 'FULFILLING' },
    };
    await this.eventRepo.save(order.id, EventTypes.ORDER_STATE_CHANGED, stateEvent.payload, client);
    await this.outboxRepo.save(order.id, Topics.ORDER_EVENTS, order.id, stateEvent, client);

    // Capture is issued only here, from FULFILLING (both authorized and reserved).
    const captureEvent: CaptureRequestedEvent = {
      eventId: uuidv4(),
      eventType: EventTypes.CAPTURE_REQUESTED,
      aggregateId: order.id,
      timestamp: new Date().toISOString(),
      correlationId,
      version: order.version,
      payload: { orderId: order.id, amount: order.total },
    };
    await this.eventRepo.save(order.id, EventTypes.CAPTURE_REQUESTED, captureEvent.payload, client);
    await this.outboxRepo.save(order.id, Topics.ORDER_EVENTS, order.id, captureEvent, client);

    ordersFulfilling.inc();
    logger.info({ orderId, correlationId }, 'Order transitioned to FULFILLING; capture requested');
  }

  async shipOrder(orderId: string, correlationId?: string): Promise<void> {
    const corrId = correlationId || uuidv4();
    await db.transaction(async (client) => {
      const order = await this.orderRepo.findById(orderId, client);
      if (!order) throw new Error(`Order ${orderId} not found`);
      order.ship();
      await this.orderRepo.save(order, client);
      await this.emitStateChange(client, order, 'FULFILLING', 'SHIPPED', corrId);
    });
    logger.info({ orderId, correlationId: corrId }, 'Order shipped');
  }

  async completeOrder(orderId: string, correlationId?: string): Promise<void> {
    const corrId = correlationId || uuidv4();
    await db.transaction(async (client) => {
      const order = await this.orderRepo.findById(orderId, client);
      if (!order) throw new Error(`Order ${orderId} not found`);
      order.complete();
      await this.orderRepo.save(order, client);
      await this.emitStateChange(client, order, 'SHIPPED', 'COMPLETED', corrId);
    });
    logger.info({ orderId, correlationId: corrId }, 'Order completed');
  }

  async cancelOrder(orderId: string, reason: string, reasonCode: string, correlationId?: string): Promise<void> {
    const corrId = correlationId || uuidv4();
    await db.transaction(async (client) => {
      await this.cancelInTransaction(client, orderId, reason, reasonCode, corrId);
    });
  }

  /**
   * Cancel within an existing transaction and emit ORDER_CANCELLED, which the
   * payment and inventory services consume to void/refund the authorization and
   * release the reservation (the compensation the previous design was missing).
   * A no-op if the order is already terminal, so out-of-order failures are safe.
   */
  private async cancelInTransaction(
    client: PoolClient,
    orderId: string,
    reason: string,
    reasonCode: string,
    correlationId: string
  ): Promise<void> {
    const order = await this.orderRepo.findById(orderId, client);
    if (!order) {
      throw new Error(`Order ${orderId} not found`);
    }
    if (order.state === 'CANCELLED' || order.state === 'COMPLETED') {
      return;
    }

    order.cancel(reason);
    await this.orderRepo.save(order, client);

    const event: OrderCancelledEvent = {
      eventId: uuidv4(),
      eventType: EventTypes.ORDER_CANCELLED,
      aggregateId: order.id,
      timestamp: new Date().toISOString(),
      correlationId,
      version: order.version,
      payload: { orderId: order.id, reason, reasonCode },
    };

    await this.eventRepo.save(order.id, EventTypes.ORDER_CANCELLED, event.payload, client);
    await this.outboxRepo.save(order.id, Topics.ORDER_EVENTS, order.id, event, client);

    ordersCancelled.inc({ reason_code: reasonCode });
    logger.info({ orderId, reason, reasonCode, correlationId }, 'Order cancelled; compensation requested');
  }

  private async emitStateChange(
    client: PoolClient,
    order: OrderAggregate,
    previousState: string,
    newState: string,
    correlationId: string
  ): Promise<void> {
    const event: OrderStateChangedEvent = {
      eventId: uuidv4(),
      eventType: EventTypes.ORDER_STATE_CHANGED,
      aggregateId: order.id,
      timestamp: new Date().toISOString(),
      correlationId,
      version: order.version,
      payload: { orderId: order.id, previousState, newState },
    };
    await this.eventRepo.save(order.id, EventTypes.ORDER_STATE_CHANGED, event.payload, client);
    await this.outboxRepo.save(order.id, Topics.ORDER_EVENTS, order.id, event, client);
  }

  async getOrder(orderId: string): Promise<OrderAggregate | null> {
    return this.orderRepo.findById(orderId);
  }

  async getOrdersByCustomer(customerId: string): Promise<OrderAggregate[]> {
    return this.orderRepo.findByCustomerId(customerId);
  }
}
