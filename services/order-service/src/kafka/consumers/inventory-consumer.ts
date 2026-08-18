import { Consumer, EachMessagePayload } from 'kafkajs';
import { OrderService } from '../../services/OrderService';
import {
  InventoryReservedEventSchema,
  InventoryFailedEventSchema,
  EventTypes,
  Topics,
} from '@orderflow/shared';
import { logger } from '../../utils/logger';

export class InventoryEventConsumer {
  constructor(
    private consumer: Consumer,
    private orderService: OrderService
  ) {}

  async start(): Promise<void> {
    await this.consumer.connect();
    await this.consumer.subscribe({ topic: Topics.INVENTORY_EVENTS, fromBeginning: false });
    await this.consumer.run({
      eachMessage: async (payload: EachMessagePayload) => this.handleMessage(payload),
    });
    logger.info('Inventory event consumer started');
  }

  private async handleMessage(payload: EachMessagePayload): Promise<void> {
    const { message } = payload;
    try {
      const event = JSON.parse(message.value?.toString() || '{}');
      const correlationId = message.headers?.correlationId?.toString() || event.correlationId;

      switch (event.eventType) {
        case EventTypes.INVENTORY_RESERVED: {
          const e = InventoryReservedEventSchema.parse(event);
          await this.orderService.handleInventoryReserved(e.payload.orderId, e.eventId, correlationId);
          break;
        }
        case EventTypes.INVENTORY_FAILED: {
          const e = InventoryFailedEventSchema.parse(event);
          await this.orderService.handleInventoryFailed(e.payload.orderId, e.payload.reason, e.eventId, correlationId);
          break;
        }
        case EventTypes.INVENTORY_RELEASED:
          await this.orderService.handleCompensationAck(
            event.payload?.orderId,
            event.eventType,
            event.eventId,
            correlationId
          );
          break;
        default:
          logger.warn({ eventType: event.eventType }, 'Unknown inventory event type');
      }
    } catch (err) {
      logger.error({ err }, 'Error processing inventory event');
      throw err; // offset not committed; Kafka redelivers
    }
  }

  async stop(): Promise<void> {
    await this.consumer.disconnect();
    logger.info('Inventory event consumer stopped');
  }
}
