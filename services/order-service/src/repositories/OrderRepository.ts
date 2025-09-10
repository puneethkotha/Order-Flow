import { PoolClient } from 'pg';
import { OrderAggregate } from '../domain/OrderAggregate';
import { OrderState } from '@orderflow/shared';
import { db } from '../db/client';

export class OrderRepository {
  async save(order: OrderAggregate, client?: PoolClient): Promise<void> {
    const queryClient = client || db;
    await queryClient.query(
      `INSERT INTO orders (id, customer_id, state, total, items, version, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (id) DO UPDATE SET
         state = EXCLUDED.state,
         version = EXCLUDED.version,
         updated_at = EXCLUDED.updated_at`,
      [
        order.id,
        order.customerId,
        order.state,
        order.total,
        JSON.stringify(order.items),
        order.version,
        order.createdAt,
        order.updatedAt,
      ]
    );
  }

  async findById(orderId: string): Promise<OrderAggregate | null> {
    const result = await db.query('SELECT * FROM orders WHERE id = $1', [orderId]);
    if (result.rows.length === 0) {
      return null;
    }
    return this.mapToAggregate(result.rows[0]);
  }

  async findByCustomerId(customerId: string): Promise<OrderAggregate[]> {
    const result = await db.query(
      'SELECT * FROM orders WHERE customer_id = $1 ORDER BY created_at DESC',
      [customerId]
    );
    return result.rows.map(this.mapToAggregate);
  }

  private mapToAggregate(row: any): OrderAggregate {
    return new OrderAggregate(
      row.id,
      row.customer_id,
      row.state as OrderState,
      row.items,
      parseFloat(row.total),
      row.version,
      row.created_at,
      row.updated_at
    );
  }
}
