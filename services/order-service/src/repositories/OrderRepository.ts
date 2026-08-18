import { PoolClient } from 'pg';
import { OrderAggregate } from '../domain/OrderAggregate';
import { OrderState } from '@orderflow/shared';
import { db } from '../db/client';

export class OptimisticLockError extends Error {
  constructor(orderId: string, expectedVersion: number) {
    super(`Optimistic lock conflict on order ${orderId} (expected version ${expectedVersion})`);
    this.name = 'OptimisticLockError';
  }
}

export class OrderRepository {
  /**
   * Insert-or-update with an optimistic concurrency guard. On update, the row
   * is only written when its stored version is exactly one behind the
   * aggregate's new version; otherwise an OptimisticLockError is thrown so the
   * caller can reprocess. This closes the lost-update hole in the previous
   * unconditional ON CONFLICT DO UPDATE.
   */
  async save(order: OrderAggregate, client?: PoolClient): Promise<void> {
    const queryClient = client || db;
    const result = await queryClient.query(
      `INSERT INTO orders (id, customer_id, state, total, items, version, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (id) DO UPDATE SET
         state = EXCLUDED.state,
         version = EXCLUDED.version,
         updated_at = EXCLUDED.updated_at
       WHERE orders.version = EXCLUDED.version - 1
       RETURNING id`,
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
    // For a fresh insert (version 1) or a guarded update, exactly one row is
    // returned. Zero rows means the WHERE guard rejected a stale update.
    if ((result.rowCount ?? 0) === 0) {
      throw new OptimisticLockError(order.id, order.version - 1);
    }
  }

  async findById(orderId: string, client?: PoolClient): Promise<OrderAggregate | null> {
    const queryClient = client || db;
    const result = await queryClient.query('SELECT * FROM orders WHERE id = $1', [orderId]);
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
