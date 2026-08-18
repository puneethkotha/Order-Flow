import { v4 as uuidv4 } from 'uuid';
import { PaymentRepository, Payment } from '../repositories/PaymentRepository';
import { OutboxRepository } from '../repositories/OutboxRepository';
import { IdempotencyRepository } from '../repositories/IdempotencyRepository';
import { db } from '../db/client';
import { PaymentStatus } from '@orderflow/shared';
import {
  PaymentAuthorizedEvent,
  PaymentFailedEvent,
  PaymentCapturedEvent,
  PaymentVoidedEvent,
  PaymentRefundedEvent,
  Topics,
  EventTypes,
} from '@orderflow/shared';
import { logger } from '../utils/logger';
import { paymentsAuthorized, paymentsCaptured, paymentsCompensated } from '../metrics';

export class PaymentService {
  constructor(
    private paymentRepo: PaymentRepository,
    private outboxRepo: OutboxRepository,
    private idempotencyRepo: IdempotencyRepository
  ) {}

  async authorizePayment(
    orderId: string,
    amount: number,
    idempotencyKey: string,
    correlationId?: string
  ): Promise<Payment> {
    const corrId = correlationId || uuidv4();

    // Business-level idempotency: at most one payment decision per order.
    const existingPayment = await this.paymentRepo.findByIdempotencyKey(idempotencyKey);
    if (existingPayment) {
      logger.info({ paymentId: existingPayment.id, orderId, idempotencyKey }, 'Payment already processed (idempotent)');
      return existingPayment;
    }

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
          payload: { paymentId: payment.id, orderId: payment.orderId, amount: payment.amount },
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

    if (success) paymentsAuthorized.inc();
    return payment;
  }

  /**
   * Capture an authorized payment. Reachable only via the coordinator's
   * CAPTURE_REQUESTED, which is issued only from FULFILLING. Idempotent by
   * eventId and a no-op unless the payment is currently AUTHORIZED.
   */
  async capturePayment(orderId: string, eventId: string, correlationId: string): Promise<void> {
    await db.transaction(async (client) => {
      if (!(await this.idempotencyRepo.claim(eventId, client))) return;

      const payment = await this.paymentRepo.findByOrderId(orderId, client);
      if (!payment || payment.status !== PaymentStatus.AUTHORIZED) {
        logger.warn({ orderId, status: payment?.status }, 'Capture skipped: payment not in AUTHORIZED');
        return;
      }

      await this.paymentRepo.updateStatus(payment.id, PaymentStatus.CAPTURED, client);
      await this.paymentRepo.recordLedger(orderId, payment.id, 'CAPTURE', payment.amount, client);

      const event: PaymentCapturedEvent = {
        eventId: uuidv4(),
        eventType: EventTypes.PAYMENT_CAPTURED,
        aggregateId: payment.id,
        timestamp: new Date().toISOString(),
        correlationId,
        version: 1,
        payload: { paymentId: payment.id, orderId, amount: payment.amount },
      };
      await this.outboxRepo.save(payment.id, Topics.PAYMENT_EVENTS, orderId, event, client);
    });
    paymentsCaptured.inc();
    logger.info({ orderId, correlationId }, 'Payment captured');
  }

  /**
   * Compensate on cancellation: refund a captured payment, or void an
   * authorization that was never captured. Idempotent by eventId; safe if the
   * cancel is observed before the authorization (no-op then).
   */
  async compensate(orderId: string, eventId: string, correlationId: string): Promise<void> {
    await db.transaction(async (client) => {
      if (!(await this.idempotencyRepo.claim(eventId, client))) return;

      const payment = await this.paymentRepo.findByOrderId(orderId, client);
      if (!payment) return;

      if (payment.status === PaymentStatus.CAPTURED) {
        await this.paymentRepo.updateStatus(payment.id, PaymentStatus.REFUNDED, client);
        await this.paymentRepo.recordLedger(orderId, payment.id, 'REFUND', payment.amount, client);
        const event: PaymentRefundedEvent = {
          eventId: uuidv4(),
          eventType: EventTypes.PAYMENT_REFUNDED,
          aggregateId: payment.id,
          timestamp: new Date().toISOString(),
          correlationId,
          version: 1,
          payload: { paymentId: payment.id, orderId, amount: payment.amount },
        };
        await this.outboxRepo.save(payment.id, Topics.PAYMENT_EVENTS, orderId, event, client);
        paymentsCompensated.inc({ kind: 'refund' });
        logger.info({ orderId, correlationId }, 'Payment refunded');
      } else if (payment.status === PaymentStatus.AUTHORIZED) {
        await this.paymentRepo.updateStatus(payment.id, PaymentStatus.VOIDED, client);
        await this.paymentRepo.recordLedger(orderId, payment.id, 'VOID', payment.amount, client);
        const event: PaymentVoidedEvent = {
          eventId: uuidv4(),
          eventType: EventTypes.PAYMENT_VOIDED,
          aggregateId: payment.id,
          timestamp: new Date().toISOString(),
          correlationId,
          version: 1,
          payload: { paymentId: payment.id, orderId, amount: payment.amount },
        };
        await this.outboxRepo.save(payment.id, Topics.PAYMENT_EVENTS, orderId, event, client);
        paymentsCompensated.inc({ kind: 'void' });
        logger.info({ orderId, correlationId }, 'Payment authorization voided');
      }
    });
  }

  async getPaymentByOrderId(orderId: string): Promise<Payment | null> {
    return this.paymentRepo.findByOrderId(orderId);
  }
}
