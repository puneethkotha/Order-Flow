import { PoolClient } from 'pg';
import { v4 as uuidv4 } from 'uuid';
import { db } from '../db/client';

export interface OutboxMessage {
  id: string;
  aggregateId: string;
  topic: string;
  key: string;
  payload: any;
  status: 'PENDING' | 'DELIVERED';
  createdAt: Date;
  deliveredAt?: Date;
}

export class OutboxRepository {
  async save(aggregateId: string, topic: string, key: string, payload: any, client?: PoolClient): Promise<string> {
    const id = uuidv4();
    const queryClient = client || db;
    await queryClient.query(
      `INSERT INTO outbox (id, aggregate_id, topic, key, payload, status)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [id, aggregateId, topic, key, JSON.stringify(payload), 'PENDING']
    );
    return id;
  }

  async findPending(limit: number = 100): Promise<OutboxMessage[]> {
    const result = await db.query(
      `SELECT * FROM outbox WHERE status = 'PENDING' ORDER BY created_at ASC LIMIT $1`,
      [limit]
    );
    return result.rows.map(this.mapToOutboxMessage);
  }

  async markDelivered(id: string): Promise<void> {
    await db.query(`UPDATE outbox SET status = 'DELIVERED', delivered_at = NOW() WHERE id = $1`, [id]);
  }

  private mapToOutboxMessage(row: any): OutboxMessage {
    return {
      id: row.id,
      aggregateId: row.aggregate_id,
      topic: row.topic,
      key: row.key,
      payload: row.payload,
      status: row.status,
      createdAt: row.created_at,
      deliveredAt: row.delivered_at,
    };
  }
}
