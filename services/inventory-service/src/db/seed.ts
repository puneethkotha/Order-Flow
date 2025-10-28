import { db } from './client';
import { logger } from '../utils/logger';

async function seed() {
  try {
    logger.info('Starting inventory seed...');

    const items = [
      { sku: 'WIDGET-001', quantity: 100 },
      { sku: 'WIDGET-002', quantity: 50 },
      { sku: 'GADGET-001', quantity: 75 },
      { sku: 'GADGET-002', quantity: 200 },
      { sku: 'TOOL-001', quantity: 30 },
      { sku: 'TOOL-002', quantity: 150 },
      { sku: 'BOOK-001', quantity: 500 },
      { sku: 'BOOK-002', quantity: 300 },
    ];

    for (const item of items) {
      await db.query(
        `INSERT INTO inventory_items (sku, quantity)
         VALUES ($1, $2)
         ON CONFLICT (sku) DO UPDATE SET quantity = EXCLUDED.quantity`,
        [item.sku, item.quantity]
      );
      logger.info({ sku: item.sku, quantity: item.quantity }, 'Seeded inventory item');
    }

    logger.info('Inventory seed completed');
    process.exit(0);
  } catch (err) {
    logger.error({ err }, 'Seed failed');
    process.exit(1);
  }
}

seed();
