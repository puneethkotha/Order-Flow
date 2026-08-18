import { Consumer, EachMessagePayload } from 'kafkajs';
import { OrderService } from '../../services/OrderService';
import {
  PaymentAuthorizedEventSchema,
  PaymentFailedEventSchema,
  PaymentCapturedEventSchema,
  EventTypes,
  Topics,
} from '@orderflow/shared';
import { logger } from '../../utils/logger';

export class PaymentEventConsumer {
  constructor(
    private consumer: Consumer,
    private orderService: OrderService
  ) {}

  async start(): Promise<void> {
    await this.consumer.connect();
    await this.consumer.subscribe({ topic: Topics.PAYMENT_EVENTS, fromBeginning: false });
    await this.consumer.run({
      eachMessage: async (payload: EachMessagePayload) => this.handleMessage(payload),
    });
    logger.info('Payment event consumer started');
  }

  private async handleMessage(payload: EachMessagePayload): Promise<void> {
    const { message } = payload;
    try {
      const event = JSON.parse(message.value?.toString() || '{}');
      const correlationId = message.headers?.correlationId?.toString() || event.correlationId;

      // Idempotency is enforced inside the service, keyed on the business
      // eventId and written in the same transaction as the effect.
      switch (event.eventType) {
        case EventTypes.PAYMENT_AUTHORIZED: {
          const e = PaymentAuthorizedEventSchema.parse(event);
          await this.orderService.handlePaymentAuthorized(e.payload.orderId, e.eventId, correlationId);
          break;
        }
        case EventTypes.PAYMENT_FAILED: {
          const e = PaymentFailedEventSchema.parse(event);
          await this.orderService.handlePaymentFailed(e.payload.orderId, e.payload.reason, e.eventId, correlationId);
          break;
        }
        case EventTypes.PAYMENT_CAPTURED: {
          const e = PaymentCapturedEventSchema.parse(event);
          await this.orderService.handlePaymentCaptured(e.payload.orderId, e.eventId, correlationId);
          break;
        }
        case EventTypes.PAYMENT_VOIDED:
        case EventTypes.PAYMENT_REFUNDED:
          await this.orderService.handleCompensationAck(
            event.payload?.orderId,
            event.eventType,
            event.eventId,
            correlationId
          );
          break;
        default:
          logger.warn({ eventType: event.eventType }, 'Unknown payment event type');
      }
    } catch (err) {
      logger.error({ err }, 'Error processing payment event');
      throw err; // offset not committed; Kafka redelivers
    }
  }

  async stop(): Promise<void> {
    await this.consumer.disconnect();
    logger.info('Payment event consumer stopped');
  }
}
