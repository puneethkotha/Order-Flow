import { v4 as uuidv4 } from 'uuid';
import { PaymentRepository, Payment } from '../repositories/PaymentRepository';
import { OutboxRepository } from '../repositories/OutboxRepository';
import { db } from '../db/client';
import { PaymentStatus } from '@orderflow/shared';
import {
  PaymentAuthorizedEvent,
  PaymentFailedEvent,
  Topics,
  EventTypes,
} from '@orderflow/shared';
import { logger } from '../utils/logger';

export class PaymentService {
  constructor(
    private paymentRepo: PaymentRepository,
    private outboxRepo: OutboxRepository
  ) {}

  async authorizePayment(
    orderId: string,
    amount: number,
    idempotencyKey: string,
    correlationId?: string
  ): Promise<Payment> {
    const corrId = correlationId || uuidv4();

    // Check if payment already exists (idempotency)
    const existingPayment = await this.paymentRepo.findByIdempotencyKey(idempotencyKey);
    if (existingPayment) {
      logger.info(
        { paymentId: existingPayment.id, orderId, idempotencyKey },
        'Payment already processed (idempotent)'
      );
      return existingPayment;
    }

    // Simulate payment authorization (in real world, call external payment gateway)
    const success = Math.random() > 0.1; // 90% success rate

    const payment: Payment = {
      id: uuidv4(),
      orderId,
      amount,
      status: success ? PaymentStatus.AUTHORIZED : PaymentStatus.FAILED,
      idempotencyKey,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    await db.transaction(async (client) => {
      await this.paymentRepo.save(payment, client);

      if (success) {
        const event: PaymentAuthorizedEvent = {
          eventId: uuidv4(),
          eventType: EventTypes.PAYMENT_AUTHORIZED,
          aggregateId: payment.id,
          timestamp: new Date().toISOString(),
          correlationId: corrId,
          version: 1,
          payload: {
            paymentId: payment.id,
            orderId: payment.orderId,
            amount: payment.amount,
          },
        };

        await this.outboxRepo.save(payment.id, Topics.PAYMENT_EVENTS, orderId, event, client);
        logger.info({ paymentId: payment.id, orderId, correlationId: corrId }, 'Payment authorized');
      } else {
        const event: PaymentFailedEvent = {
          eventId: uuidv4(),
          eventType: EventTypes.PAYMENT_FAILED,
          aggregateId: payment.id,
          timestamp: new Date().toISOString(),
          correlationId: corrId,
          version: 1,
          payload: {
            paymentId: payment.id,
            orderId: payment.orderId,
            amount: payment.amount,
            reason: 'Payment gateway declined transaction',
          },
        };

        await this.outboxRepo.save(payment.id, Topics.PAYMENT_EVENTS, orderId, event, client);
        logger.warn({ paymentId: payment.id, orderId, correlationId: corrId }, 'Payment failed');
      }
    });

    return payment;
  }

  async getPaymentByOrderId(orderId: string): Promise<Payment | null> {
    return this.paymentRepo.findByOrderId(orderId);
  }
}
