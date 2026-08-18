import { PoolClient } from 'pg';
import { db } from '../db/client';

export interface OrderStateTracking {
  orderId: string;
  paymentAuthorized: boolean;
  inventoryReserved: boolean;
  paymentCaptured: boolean;
  updatedAt: Date;
}

export class StateTrackingRepository {
  async upsert(orderId: string, client?: PoolClient): Promise<void> {
    const queryClient = client || db;
    await queryClient.query(
      `INSERT INTO order_state_tracking (order_id, payment_authorized, inventory_reserved, payment_captured)
       VALUES ($1, false, false, false)
       ON CONFLICT (order_id) DO NOTHING`,
      [orderId]
    );
  }

  async updatePaymentStatus(orderId: string, authorized: boolean, client?: PoolClient): Promise<void> {
    const queryClient = client || db;
    await queryClient.query(
      `UPDATE order_state_tracking SET payment_authorized = $1, updated_at = NOW()
       WHERE order_id = $2`,
      [authorized, orderId]
    );
  }

  async updateInventoryStatus(orderId: string, reserved: boolean, client?: PoolClient): Promise<void> {
    const queryClient = client || db;
    await queryClient.query(
      `UPDATE order_state_tracking SET inventory_reserved = $1, updated_at = NOW()
       WHERE order_id = $2`,
      [reserved, orderId]
    );
  }

  async updatePaymentCaptured(orderId: string, captured: boolean, client?: PoolClient): Promise<void> {
    const queryClient = client || db;
    await queryClient.query(
      `UPDATE order_state_tracking SET payment_captured = $1, updated_at = NOW()
       WHERE order_id = $2`,
      [captured, orderId]
    );
  }

  async findByOrderId(orderId: string, client?: PoolClient): Promise<OrderStateTracking | null> {
    const queryClient = client || db;
    const result = await queryClient.query(
      'SELECT * FROM order_state_tracking WHERE order_id = $1',
      [orderId]
    );
    if (result.rows.length === 0) {
      return null;
    }
    return this.mapToStateTracking(result.rows[0]);
  }

  /**
   * Read the tracking row inside the caller's transaction and take a row lock.
   * This is the fix for the stuck-saga race: the two coordinator handlers now
   * serialize on this row and each sees the other's committed write, so the
   * join predicate is evaluated against a consistent snapshot that includes the
   * handler's own contribution.
   */
  async findByOrderIdForUpdate(orderId: string, client: PoolClient): Promise<OrderStateTracking | null> {
    const result = await client.query(
      'SELECT * FROM order_state_tracking WHERE order_id = $1 FOR UPDATE',
      [orderId]
    );
    if (result.rows.length === 0) {
      return null;
    }
    return this.mapToStateTracking(result.rows[0]);
  }

  private mapToStateTracking(row: any): OrderStateTracking {
    return {
      orderId: row.order_id,
      paymentAuthorized: row.payment_authorized,
      inventoryReserved: row.inventory_reserved,
      paymentCaptured: row.payment_captured,
      updatedAt: row.updated_at,
    };
  }
}
