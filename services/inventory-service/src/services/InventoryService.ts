import { v4 as uuidv4 } from 'uuid';
import { InventoryRepository } from '../repositories/InventoryRepository';
import { ReservationRepository } from '../repositories/ReservationRepository';
import { OutboxRepository } from '../repositories/OutboxRepository';
import { IdempotencyRepository } from '../repositories/IdempotencyRepository';
import { db } from '../db/client';
import {
  InventoryReservedEvent,
  InventoryFailedEvent,
  InventoryReleasedEvent,
  InventoryReservationStatus,
  Topics,
  EventTypes,
  OrderItem,
} from '@orderflow/shared';
import { logger } from '../utils/logger';
import { inventoryReserved, inventoryReleased } from '../metrics';

export class InventoryService {
  constructor(
    private inventoryRepo: InventoryRepository,
    private reservationRepo: ReservationRepository,
    private outboxRepo: OutboxRepository,
    private idempotencyRepo: IdempotencyRepository
  ) {}

  /**
   * Reserve inventory for an order. Idempotent by the business eventId written
   * in the same transaction as the reservation, so a re-delivered
   * ORDER_APPROVED (a new Kafka offset, the same eventId) does not
   * double-reserve. This is the fix for the offset-keyed duplicate defect.
   */
  async reserveInventory(orderId: string, items: OrderItem[], eventId: string, correlationId: string): Promise<void> {
    await db.transaction(async (client) => {
      if (!(await this.idempotencyRepo.claim(eventId, client))) return;

      const reservations: { id: string; sku: string; quantity: number }[] = [];
      const failedItems: { sku: string; requestedQuantity: number; availableQuantity: number }[] = [];

      for (const item of items) {
        const reserved = await this.inventoryRepo.reserveQuantity(item.sku, item.quantity, client);
        if (reserved) {
          const row = await this.reservationRepo.create(orderId, item.sku, item.quantity, client);
          reservations.push({ id: row.id, sku: item.sku, quantity: item.quantity });
        } else {
          const inventoryItem = await this.inventoryRepo.findBySku(item.sku, client);
          const available = inventoryItem ? inventoryItem.quantity - inventoryItem.reservedQuantity : 0;
          failedItems.push({ sku: item.sku, requestedQuantity: item.quantity, availableQuantity: available });
        }
      }

      if (failedItems.length > 0) {
        // Roll back any partial reservations made in this transaction so a
        // partially-failed order leaks no stock and leaves no active row that a
        // later cancel could release a second time.
        for (const r of reservations) {
          await this.inventoryRepo.releaseQuantity(r.sku, r.quantity, client);
          await this.reservationRepo.updateStatus(r.id, InventoryReservationStatus.RELEASED, client);
        }
        const event: InventoryFailedEvent = {
          eventId: uuidv4(),
          eventType: EventTypes.INVENTORY_FAILED,
          aggregateId: orderId,
          timestamp: new Date().toISOString(),
          correlationId,
          version: 1,
          payload: { orderId, reason: 'Insufficient inventory', failedItems },
        };
        await this.outboxRepo.save(orderId, Topics.INVENTORY_EVENTS, orderId, event, client);
        logger.warn({ orderId, failedItems, correlationId }, 'Inventory reservation failed');
        return;
      }

      const event: InventoryReservedEvent = {
        eventId: uuidv4(),
        eventType: EventTypes.INVENTORY_RESERVED,
        aggregateId: orderId,
        timestamp: new Date().toISOString(),
        correlationId,
        version: 1,
        payload: {
          reservationId: uuidv4(),
          orderId,
          items: reservations.map((r) => ({ sku: r.sku, quantity: r.quantity })),
        },
      };
      await this.outboxRepo.save(orderId, Topics.INVENTORY_EVENTS, orderId, event, client);
      logger.info({ orderId, items: reservations, correlationId }, 'Inventory reserved');
    });
    inventoryReserved.inc();
  }

  /**
   * Release an order's active reservations on cancellation. Idempotent by
   * eventId; a no-op if there is nothing reserved. This is the compensation the
   * previous design lacked, and the reason terminal-cancelled orders now hold
   * zero reserved stock (invariant I4).
   */
  async releaseReservation(orderId: string, eventId: string, correlationId: string): Promise<void> {
    await db.transaction(async (client) => {
      if (!(await this.idempotencyRepo.claim(eventId, client))) return;

      const reservations = await this.reservationRepo.findByOrderId(orderId);
      const active = reservations.filter((r) => r.status === InventoryReservationStatus.RESERVED);
      if (active.length === 0) return;

      const released: { sku: string; quantity: number }[] = [];
      for (const r of active) {
        await this.inventoryRepo.releaseQuantity(r.sku, r.quantity, client);
        await this.reservationRepo.updateStatus(r.id, InventoryReservationStatus.RELEASED, client);
        released.push({ sku: r.sku, quantity: r.quantity });
      }

      const event: InventoryReleasedEvent = {
        eventId: uuidv4(),
        eventType: EventTypes.INVENTORY_RELEASED,
        aggregateId: orderId,
        timestamp: new Date().toISOString(),
        correlationId,
        version: 1,
        payload: { orderId, items: released },
      };
      await this.outboxRepo.save(orderId, Topics.INVENTORY_EVENTS, orderId, event, client);
      inventoryReleased.inc();
      logger.info({ orderId, released, correlationId }, 'Inventory released (compensation)');
    });
  }
}
