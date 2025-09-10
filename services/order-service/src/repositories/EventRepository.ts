import { PoolClient } from 'pg';
import { v4 as uuidv4 } from 'uuid';
import { db } from '../db/client';

export interface OrderEvent {
  id: string;
  orderId: string;
  eventType: string;
  payload: any;
  createdAt: Date;
}

export class EventRepository {
  async save(orderId: string, eventType: string, payload: any, client?: PoolClient): Promise<void> {
    const id = uuidv4();
    const queryClient = client || db;
    await queryClient.query(
      `INSERT INTO order_events (id, order_id, event_type, payload)
       VALUES ($1, $2, $3, $4)`,
      [id, orderId, eventType, JSON.stringify(payload)]
    );
  }

  async findByOrderId(orderId: string): Promise<OrderEvent[]> {
    const result = await db.query(
      'SELECT * FROM order_events WHERE order_id = $1 ORDER BY created_at ASC',
      [orderId]
    );
    return result.rows.map(this.mapToEvent);
  }

  private mapToEvent(row: any): OrderEvent {
    return {
      id: row.id,
      orderId: row.order_id,
      eventType: row.event_type,
      payload: row.payload,
      createdAt: row.created_at,
    };
  }
}
