import { PoolClient } from 'pg';
import { db } from '../db/client';

export class IdempotencyRepository {
  /**
   * Atomically claim a business eventId inside the caller's transaction.
   * Returns true if this is the first time the event is seen (the caller should
   * apply the effect), false if it was already processed (skip). Keying on the
   * business eventId (not the Kafka offset) means a re-published outbox row is
   * correctly deduplicated, and doing it on the same `client` as the business
   * change makes dedup atomic with the effect.
   */
  async claim(eventId: string, client: PoolClient): Promise<boolean> {
    const result = await client.query(
      `INSERT INTO processed_messages (message_id) VALUES ($1)
       ON CONFLICT DO NOTHING
       RETURNING message_id`,
      [eventId]
    );
    return (result.rowCount ?? 0) > 0;
  }

  async isProcessed(eventId: string): Promise<boolean> {
    const result = await db.query(
      'SELECT 1 FROM processed_messages WHERE message_id = $1',
      [eventId]
    );
    return result.rows.length > 0;
  }
}
