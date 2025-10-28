import { PoolClient } from 'pg';
import { db } from '../db/client';

export interface InventoryItem {
  sku: string;
  quantity: number;
  reservedQuantity: number;
  createdAt: Date;
  updatedAt: Date;
}

export class InventoryRepository {
  async findBySku(sku: string, client?: PoolClient): Promise<InventoryItem | null> {
    const queryClient = client || db;
    const result = await queryClient.query('SELECT * FROM inventory_items WHERE sku = $1', [sku]);
    if (result.rows.length === 0) {
      return null;
    }
    return this.mapToInventoryItem(result.rows[0]);
  }

  async reserveQuantity(sku: string, quantity: number, client?: PoolClient): Promise<boolean> {
    const queryClient = client || db;
    
    // Use SELECT FOR UPDATE to lock row
    const item = await queryClient.query(
      'SELECT * FROM inventory_items WHERE sku = $1 FOR UPDATE',
      [sku]
    );

    if (item.rows.length === 0) {
      return false;
    }

    const availableQty = item.rows[0].quantity - item.rows[0].reserved_quantity;
    if (availableQty < quantity) {
      return false;
    }

    await queryClient.query(
      'UPDATE inventory_items SET reserved_quantity = reserved_quantity + $1, updated_at = NOW() WHERE sku = $2',
      [quantity, sku]
    );

    return true;
  }

  async releaseQuantity(sku: string, quantity: number, client?: PoolClient): Promise<void> {
    const queryClient = client || db;
    await queryClient.query(
      'UPDATE inventory_items SET reserved_quantity = reserved_quantity - $1, updated_at = NOW() WHERE sku = $2',
      [quantity, sku]
    );
  }

  async decrementQuantity(sku: string, quantity: number, client?: PoolClient): Promise<void> {
    const queryClient = client || db;
    await queryClient.query(
      `UPDATE inventory_items 
       SET quantity = quantity - $1, 
           reserved_quantity = reserved_quantity - $1,
           updated_at = NOW() 
       WHERE sku = $2`,
      [quantity, sku]
    );
  }

  private mapToInventoryItem(row: any): InventoryItem {
    return {
      sku: row.sku,
      quantity: row.quantity,
      reservedQuantity: row.reserved_quantity,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}
