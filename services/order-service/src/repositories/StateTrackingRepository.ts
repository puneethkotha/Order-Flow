import { PoolClient } from 'pg';
import { db } from '../db/client';

export interface OrderStateTracking {
  orderId: string;
  paymentAuthorized: boolean;
  inventoryReserved: boolean;
  updatedAt: Date;
}

export class StateTrackingRepository {
  async upsert(orderId: string, client?: PoolClient): Promise<void> {
    const queryClient = client || db;
    await queryClient.query(
      `INSERT INTO order_state_tracking (order_id, payment_authorized, inventory_reserved)
       VALUES ($1, false, false)
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

  async findByOrderId(orderId: string): Promise<OrderStateTracking | null> {
    const result = await db.query(
      'SELECT * FROM order_state_tracking WHERE order_id = $1',
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
      updatedAt: row.updated_at,
    };
  }
}
