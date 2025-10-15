import { Consumer, EachMessagePayload } from 'kafkajs';
import { PaymentService } from '../services/PaymentService';
import { IdempotencyRepository } from '../repositories/IdempotencyRepository';
import { OrderApprovedEventSchema, EventTypes, Topics } from '@orderflow/shared';
import { logger } from '../utils/logger';

export class OrderEventConsumer {
  constructor(
    private consumer: Consumer,
    private paymentService: PaymentService,
    private idempotencyRepo: IdempotencyRepository
  ) {}

  async start(): Promise<void> {
    await this.consumer.connect();
    await this.consumer.subscribe({ topic: Topics.ORDER_EVENTS, fromBeginning: false });

    await this.consumer.run({
      eachMessage: async (payload: EachMessagePayload) => {
        await this.handleMessage(payload);
      },
    });

    logger.info('Order event consumer started');
  }

  private async handleMessage(payload: EachMessagePayload): Promise<void> {
    const { topic, partition, message } = payload;
    const messageId = `${topic}-${partition}-${message.offset}`;

    try {
      if (await this.idempotencyRepo.isProcessed(messageId)) {
        logger.debug({ messageId }, 'Message already processed, skipping');
        return;
      }

      const event = JSON.parse(message.value?.toString() || '{}');
      const correlationId = message.headers?.correlationId?.toString() || event.correlationId;

      if (event.eventType === EventTypes.ORDER_APPROVED) {
        const approvedEvent = OrderApprovedEventSchema.parse(event);
        logger.info(
          { orderId: approvedEvent.payload.orderId, correlationId },
          'Processing ORDER_APPROVED event'
        );

        const idempotencyKey = `order-${approvedEvent.payload.orderId}`;
        await this.paymentService.authorizePayment(
          approvedEvent.payload.orderId,
          approvedEvent.payload.total,
          idempotencyKey,
          correlationId
        );

        await this.idempotencyRepo.markProcessed(messageId);
      }
    } catch (err) {
      logger.error({ err, messageId }, 'Error processing order event');
      throw err;
    }
  }

  async stop(): Promise<void> {
    await this.consumer.disconnect();
    logger.info('Order event consumer stopped');
  }
}
