import { PoolClient } from 'pg';
import { v4 as uuidv4 } from 'uuid';
import { db } from '../db/client';
import { InventoryReservationStatus } from '@orderflow/shared';

export interface Reservation {
  id: string;
  orderId: string;
  sku: string;
  quantity: number;
  status: InventoryReservationStatus;
  createdAt: Date;
  updatedAt: Date;
}

export class ReservationRepository {
  async create(orderId: string, sku: string, quantity: number, client?: PoolClient): Promise<Reservation> {
    const id = uuidv4();
    const queryClient = client || db;

    await queryClient.query(
      `INSERT INTO inventory_reservations (id, order_id, sku, quantity, status)
       VALUES ($1, $2, $3, $4, $5)`,
      [id, orderId, sku, quantity, InventoryReservationStatus.RESERVED]
    );

    const result = await queryClient.query('SELECT * FROM inventory_reservations WHERE id = $1', [id]);
    return this.mapToReservation(result.rows[0]);
  }

  async findByOrderId(orderId: string): Promise<Reservation[]> {
    const result = await db.query('SELECT * FROM inventory_reservations WHERE order_id = $1', [orderId]);
    return result.rows.map(this.mapToReservation);
  }

  async updateStatus(id: string, status: InventoryReservationStatus, client?: PoolClient): Promise<void> {
    const queryClient = client || db;
    await queryClient.query(
      'UPDATE inventory_reservations SET status = $1, updated_at = NOW() WHERE id = $2',
      [status, id]
    );
  }

  private mapToReservation(row: any): Reservation {
    return {
      id: row.id,
      orderId: row.order_id,
      sku: row.sku,
      quantity: row.quantity,
      status: row.status as InventoryReservationStatus,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}
