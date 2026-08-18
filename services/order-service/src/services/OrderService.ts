import { OrderAggregate } from '../domain/OrderAggregate';
import { OrderRepository } from '../repositories/OrderRepository';
import { OutboxRepository } from '../repositories/OutboxRepository';
import { EventRepository } from '../repositories/EventRepository';
import { StateTrackingRepository } from '../repositories/StateTrackingRepository';
import { db } from '../db/client';
import { v4 as uuidv4 } from 'uuid';
import {
  OrderCreatedEvent,
  OrderApprovedEvent,
  OrderStateChangedEvent,
  OrderCancelledEvent,
  Topics,
  EventTypes,
  OrderItem,
} from '@orderflow/shared';
import { logger } from '../utils/logger';

export class OrderService {
  constructor(
    private orderRepo: OrderRepository,
    private outboxRepo: OutboxRepository,
    private eventRepo: EventRepository,
    private stateTrackingRepo: StateTrackingRepository
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

    logger.info({ orderId: order.id, correlationId: corrId }, 'Order created');
    return order;
  }

  async approveOrder(orderId: string, correlationId?: string): Promise<void> {
    const corrId = correlationId || uuidv4();

    await db.transaction(async (client) => {
      const order = await this.orderRepo.findById(orderId);
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

  async handlePaymentAuthorized(orderId: string, correlationId: string): Promise<void> {
    await db.transaction(async (client) => {
      await this.stateTrackingRepo.updatePaymentStatus(orderId, true, client);
      await this.tryTransitionToFulfilling(orderId, correlationId, client);
    });
  }

  async handlePaymentFailed(orderId: string, reason: string, correlationId: string): Promise<void> {
    await this.cancelOrder(orderId, reason, 'PAYMENT_FAILED', correlationId);
  }

  async handleInventoryReserved(orderId: string, correlationId: string): Promise<void> {
    await db.transaction(async (client) => {
      await this.stateTrackingRepo.updateInventoryStatus(orderId, true, client);
      await this.tryTransitionToFulfilling(orderId, correlationId, client);
    });
  }

  async handleInventoryFailed(orderId: string, reason: string, correlationId: string): Promise<void> {
    await this.cancelOrder(orderId, reason, 'INVENTORY_FAILED', correlationId);
  }

  private async tryTransitionToFulfilling(orderId: string, correlationId: string, client: any): Promise<void> {
    const order = await this.orderRepo.findById(orderId);
    if (!order) {
      throw new Error(`Order ${orderId} not found`);
    }

    const tracking = await this.stateTrackingRepo.findByOrderId(orderId);
    if (!tracking) {
      logger.warn({ orderId }, 'State tracking not found');
      return;
    }

    if (order.canTransitionToFulfilling(tracking.paymentAuthorized, tracking.inventoryReserved)) {
      order.startFulfilling();
      await this.orderRepo.save(order, client);

      const event: OrderStateChangedEvent = {
        eventId: uuidv4(),
        eventType: EventTypes.ORDER_STATE_CHANGED,
        aggregateId: order.id,
        timestamp: new Date().toISOString(),
        correlationId,
        version: order.version,
        payload: {
          orderId: order.id,
          previousState: 'APPROVED',
          newState: 'FULFILLING',
        },
      };

      await this.eventRepo.save(order.id, EventTypes.ORDER_STATE_CHANGED, event.payload, client);
      await this.outboxRepo.save(order.id, Topics.ORDER_EVENTS, order.id, event, client);

      logger.info({ orderId, correlationId }, 'Order transitioned to FULFILLING');
    }
  }

  async shipOrder(orderId: string, correlationId?: string): Promise<void> {
    const corrId = correlationId || uuidv4();

    await db.transaction(async (client) => {
      const order = await this.orderRepo.findById(orderId);
      if (!order) {
        throw new Error(`Order ${orderId} not found`);
      }

      order.ship();
      await this.orderRepo.save(order, client);

      const event: OrderStateChangedEvent = {
        eventId: uuidv4(),
        eventType: EventTypes.ORDER_STATE_CHANGED,
        aggregateId: order.id,
        timestamp: new Date().toISOString(),
        correlationId: corrId,
        version: order.version,
        payload: {
          orderId: order.id,
          previousState: 'FULFILLING',
          newState: 'SHIPPED',
        },
      };

      await this.eventRepo.save(order.id, EventTypes.ORDER_STATE_CHANGED, event.payload, client);
      await this.outboxRepo.save(order.id, Topics.ORDER_EVENTS, order.id, event, client);
    });

    logger.info({ orderId, correlationId: corrId }, 'Order shipped');
  }

  async completeOrder(orderId: string, correlationId?: string): Promise<void> {
    const corrId = correlationId || uuidv4();

    await db.transaction(async (client) => {
      const order = await this.orderRepo.findById(orderId);
      if (!order) {
        throw new Error(`Order ${orderId} not found`);
      }

      order.complete();
      await this.orderRepo.save(order, client);

      const event: OrderStateChangedEvent = {
        eventId: uuidv4(),
        eventType: EventTypes.ORDER_STATE_CHANGED,
        aggregateId: order.id,
        timestamp: new Date().toISOString(),
        correlationId: corrId,
        version: order.version,
        payload: {
          orderId: order.id,
          previousState: 'SHIPPED',
          newState: 'COMPLETED',
        },
      };

      await this.eventRepo.save(order.id, EventTypes.ORDER_STATE_CHANGED, event.payload, client);
      await this.outboxRepo.save(order.id, Topics.ORDER_EVENTS, order.id, event, client);
    });

    logger.info({ orderId, correlationId: corrId }, 'Order completed');
  }

  async cancelOrder(orderId: string, reason: string, reasonCode: string, correlationId?: string): Promise<void> {
    const corrId = correlationId || uuidv4();

    await db.transaction(async (client) => {
      const order = await this.orderRepo.findById(orderId);
      if (!order) {
        throw new Error(`Order ${orderId} not found`);
      }

      order.cancel(reason);
      await this.orderRepo.save(order, client);

      const event: OrderCancelledEvent = {
        eventId: uuidv4(),
        eventType: EventTypes.ORDER_CANCELLED,
        aggregateId: order.id,
        timestamp: new Date().toISOString(),
        correlationId: corrId,
        version: order.version,
        payload: {
          orderId: order.id,
          reason,
          reasonCode,
        },
      };

      await this.eventRepo.save(order.id, EventTypes.ORDER_CANCELLED, event.payload, client);
      await this.outboxRepo.save(order.id, Topics.ORDER_EVENTS, order.id, event, client);
    });

    logger.info({ orderId, reason, reasonCode, correlationId: corrId }, 'Order cancelled');
  }

  async getOrder(orderId: string): Promise<OrderAggregate | null> {
    return this.orderRepo.findById(orderId);
  }

  async getOrdersByCustomer(customerId: string): Promise<OrderAggregate[]> {
    return this.orderRepo.findByCustomerId(customerId);
  }
}
