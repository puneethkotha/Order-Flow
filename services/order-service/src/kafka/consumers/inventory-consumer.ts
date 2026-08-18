import { Consumer, EachMessagePayload } from 'kafkajs';
import { OrderService } from '../../services/OrderService';
import { IdempotencyRepository } from '../../repositories/IdempotencyRepository';
import {
  InventoryReservedEventSchema,
  InventoryFailedEventSchema,
  EventTypes,
} from '@orderflow/shared';
import { logger } from '../../utils/logger';
import { kafkaProducer } from '../producer';
import { Topics } from '@orderflow/shared';

export class InventoryEventConsumer {
  constructor(
    private consumer: Consumer,
    private orderService: OrderService,
    private idempotencyRepo: IdempotencyRepository,
    private maxRetries: number = 3
  ) {}

  async start(): Promise<void> {
    await this.consumer.connect();
    await this.consumer.subscribe({ topic: Topics.INVENTORY_EVENTS, fromBeginning: false });

    await this.consumer.run({
      eachMessage: async (payload: EachMessagePayload) => {
        await this.handleMessage(payload);
      },
    });

    logger.info('Inventory event consumer started');
  }

  private async handleMessage(payload: EachMessagePayload): Promise<void> {
    const { topic, partition, message } = payload;
    const messageId = `${topic}-${partition}-${message.offset}`;

    try {
      // Check idempotency
      if (await this.idempotencyRepo.isProcessed(messageId)) {
        logger.debug({ messageId }, 'Message already processed, skipping');
        return;
      }

      const event = JSON.parse(message.value?.toString() || '{}');
      const correlationId = message.headers?.correlationId?.toString() || event.correlationId;

      logger.info(
        { eventType: event.eventType, orderId: event.payload?.orderId, correlationId },
        'Processing inventory event'
      );

      switch (event.eventType) {
        case EventTypes.INVENTORY_RESERVED: {
          const reservedEvent = InventoryReservedEventSchema.parse(event);
          await this.orderService.handleInventoryReserved(
            reservedEvent.payload.orderId,
            correlationId
          );
          break;
        }

        case EventTypes.INVENTORY_FAILED: {
          const failedEvent = InventoryFailedEventSchema.parse(event);
          await this.orderService.handleInventoryFailed(
            failedEvent.payload.orderId,
            failedEvent.payload.reason,
            correlationId
          );
          break;
        }

        default:
          logger.warn({ eventType: event.eventType }, 'Unknown inventory event type');
      }

      // Mark as processed
      await this.idempotencyRepo.markProcessed(messageId);
    } catch (err) {
      logger.error({ err, messageId }, 'Error processing inventory event');

      const retryCount = parseInt(message.headers?.retryCount?.toString() || '0', 10);
      if (retryCount < this.maxRetries) {
        await this.retryMessage(message, retryCount + 1);
      } else {
        await this.sendToDLQ(message, err);
      }

      throw err;
    }
  }

  private async retryMessage(message: any, retryCount: number): Promise<void> {
    logger.info({ retryCount }, 'Retrying message');
  }

  private async sendToDLQ(message: any, error: any): Promise<void> {
    try {
      await kafkaProducer.send({
        topic: Topics.DLQ,
        messages: [
          {
            key: message.key,
            value: message.value,
            headers: {
              ...message.headers,
              originalTopic: Topics.INVENTORY_EVENTS,
              error: error?.message || 'Unknown error',
              failedAt: new Date().toISOString(),
            },
          },
        ],
      });
      logger.warn({ messageKey: message.key?.toString() }, 'Message sent to DLQ');
    } catch (err) {
      logger.error({ err }, 'Failed to send message to DLQ');
    }
  }

  async stop(): Promise<void> {
    await this.consumer.disconnect();
    logger.info('Inventory event consumer stopped');
  }
}
