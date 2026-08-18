import { PoolClient } from 'pg';
import { db } from '../db/client';
import { PaymentStatus } from '@orderflow/shared';

export interface Payment {
  id: string;
  orderId: string;
  amount: number;
  status: PaymentStatus;
  idempotencyKey: string;
  createdAt: Date;
  updatedAt: Date;
}

export class PaymentRepository {
  async save(payment: Payment, client?: PoolClient): Promise<void> {
    const queryClient = client || db;
    await queryClient.query(
      `INSERT INTO payments (id, order_id, amount, status, idempotency_key, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (idempotency_key) DO UPDATE SET
         status = EXCLUDED.status,
         updated_at = EXCLUDED.updated_at`,
      [payment.id, payment.orderId, payment.amount, payment.status, payment.idempotencyKey, payment.createdAt, payment.updatedAt]
    );
  }

  async findByIdempotencyKey(idempotencyKey: string): Promise<Payment | null> {
    const result = await db.query('SELECT * FROM payments WHERE idempotency_key = $1', [idempotencyKey]);
    if (result.rows.length === 0) {
      return null;
    }
    return this.mapToPayment(result.rows[0]);
  }

  async findByOrderId(orderId: string, client?: PoolClient): Promise<Payment | null> {
    const queryClient = client || db;
    const result = await queryClient.query('SELECT * FROM payments WHERE order_id = $1', [orderId]);
    if (result.rows.length === 0) {
      return null;
    }
    return this.mapToPayment(result.rows[0]);
  }

  async updateStatus(id: string, status: PaymentStatus, client?: PoolClient): Promise<void> {
    const queryClient = client || db;
    await queryClient.query(
      'UPDATE payments SET status = $1, updated_at = NOW() WHERE id = $2',
      [status, id]
    );
  }

  async recordLedger(
    orderId: string,
    paymentId: string,
    kind: string,
    amount: number,
    client: PoolClient
  ): Promise<void> {
    await client.query(
      `INSERT INTO payment_ledger (id, order_id, payment_id, kind, amount)
       VALUES (gen_random_uuid(), $1, $2, $3, $4)`,
      [orderId, paymentId, kind, amount]
    );
  }

  private mapToPayment(row: any): Payment {
    return {
      id: row.id,
      orderId: row.order_id,
      amount: parseFloat(row.amount),
      status: row.status as PaymentStatus,
      idempotencyKey: row.idempotency_key,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}
