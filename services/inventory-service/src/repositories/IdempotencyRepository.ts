import { PoolClient } from 'pg';
import { db } from '../db/client';

export class IdempotencyRepository {
  async isProcessed(messageId: string): Promise<boolean> {
    const result = await db.query('SELECT 1 FROM processed_messages WHERE message_id = $1', [messageId]);
    return result.rows.length > 0;
  }

  async markProcessed(messageId: string, client?: PoolClient): Promise<void> {
    const queryClient = client || db;
    await queryClient.query(
      `INSERT INTO processed_messages (message_id) VALUES ($1) ON CONFLICT DO NOTHING`,
      [messageId]
    );
  }
}
