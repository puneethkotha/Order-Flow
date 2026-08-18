import { Consumer, EachMessagePayload } from 'kafkajs';
import { InventoryService } from '../services/InventoryService';
import {
  OrderApprovedEventSchema,
  OrderCancelledEventSchema,
  EventTypes,
  Topics,
} from '@orderflow/shared';
import { logger } from '../utils/logger';

export class OrderEventConsumer {
  constructor(
    private consumer: Consumer,
    private inventoryService: InventoryService
  ) {}

  async start(): Promise<void> {
    await this.consumer.connect();
    await this.consumer.subscribe({ topic: Topics.ORDER_EVENTS, fromBeginning: false });
    await this.consumer.run({
      eachMessage: async (payload: EachMessagePayload) => this.handleMessage(payload),
    });
    logger.info('Order event consumer started');
  }

  private async handleMessage(payload: EachMessagePayload): Promise<void> {
    const { message } = payload;
    try {
      const event = JSON.parse(message.value?.toString() || '{}');
      const correlationId = message.headers?.correlationId?.toString() || event.correlationId;

      switch (event.eventType) {
        case EventTypes.ORDER_APPROVED: {
          const e = OrderApprovedEventSchema.parse(event);
          await this.inventoryService.reserveInventory(
            e.payload.orderId,
            e.payload.items,
            e.eventId,
            correlationId
          );
          break;
        }
        case EventTypes.ORDER_CANCELLED: {
          const e = OrderCancelledEventSchema.parse(event);
          await this.inventoryService.releaseReservation(e.payload.orderId, e.eventId, correlationId);
          break;
        }
        default:
          break;
      }
    } catch (err) {
      logger.error({ err }, 'Error processing order event');
      throw err; // offset not committed; Kafka redelivers
    }
  }

  async stop(): Promise<void> {
    await this.consumer.disconnect();
    logger.info('Order event consumer stopped');
  }
}
