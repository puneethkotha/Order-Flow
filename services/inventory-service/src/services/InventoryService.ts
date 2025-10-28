import { v4 as uuidv4 } from 'uuid';
import { InventoryRepository } from '../repositories/InventoryRepository';
import { ReservationRepository } from '../repositories/ReservationRepository';
import { OutboxRepository } from '../repositories/OutboxRepository';
import { db } from '../db/client';
import {
  InventoryReservedEvent,
  InventoryFailedEvent,
  Topics,
  EventTypes,
  OrderItem,
} from '@orderflow/shared';
import { logger } from '../utils/logger';

export class InventoryService {
  constructor(
    private inventoryRepo: InventoryRepository,
    private reservationRepo: ReservationRepository,
    private outboxRepo: OutboxRepository
  ) {}

  async reserveInventory(orderId: string, items: OrderItem[], correlationId: string): Promise<void> {
    try {
      await db.transaction(async (client) => {
        const reservations = [];
        const failedItems = [];

        // Try to reserve all items
        for (const item of items) {
          const reserved = await this.inventoryRepo.reserveQuantity(item.sku, item.quantity, client);

          if (reserved) {
            const reservation = await this.reservationRepo.create(orderId, item.sku, item.quantity, client);
            reservations.push({ sku: item.sku, quantity: item.quantity });
          } else {
            const inventoryItem = await this.inventoryRepo.findBySku(item.sku, client);
            const available = inventoryItem
              ? inventoryItem.quantity - inventoryItem.reservedQuantity
              : 0;

            failedItems.push({
              sku: item.sku,
              requestedQuantity: item.quantity,
              availableQuantity: available,
            });
          }
        }

        // If any item failed, rollback and emit failure event
        if (failedItems.length > 0) {
          const event: InventoryFailedEvent = {
            eventId: uuidv4(),
            eventType: EventTypes.INVENTORY_FAILED,
            aggregateId: orderId,
            timestamp: new Date().toISOString(),
            correlationId,
            version: 1,
            payload: {
              orderId,
              reason: 'Insufficient inventory',
              failedItems,
            },
          };

          await this.outboxRepo.save(orderId, Topics.INVENTORY_EVENTS, orderId, event, client);
          logger.warn({ orderId, failedItems, correlationId }, 'Inventory reservation failed');
          return;
        }

        // All items reserved successfully
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
            items: reservations,
          },
        };

        await this.outboxRepo.save(orderId, Topics.INVENTORY_EVENTS, orderId, event, client);
        logger.info({ orderId, items: reservations, correlationId }, 'Inventory reserved');
      });
    } catch (err) {
      logger.error({ err, orderId }, 'Error reserving inventory');
      throw err;
    }
  }
}
