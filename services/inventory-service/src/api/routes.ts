import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { InventoryService } from '../services/InventoryService';
import { InventoryRepository } from '../repositories/InventoryRepository';
import { db } from '../db/client';
import { logger } from '../utils/logger';

export function registerRoutes(app: FastifyInstance, inventoryService: InventoryService, inventoryRepo: InventoryRepository): void {
  app.get('/health', async (request: FastifyRequest, reply: FastifyReply) => {
    return { status: 'healthy', service: 'inventory-service', timestamp: new Date().toISOString() };
  });

  app.get('/metrics', async (request: FastifyRequest, reply: FastifyReply) => {
    return { message: 'Metrics endpoint - integrate prom-client here' };
  });

  app.post(
    '/inventory/seed',
    async (request: FastifyRequest<{ Body: { items: Array<{ sku: string; quantity: number }> } }>, reply: FastifyReply) => {
      try {
        if (!request.body.items || !Array.isArray(request.body.items)) {
          return reply.code(400).send({ error: 'items array is required' });
        }

        for (const item of request.body.items) {
          await db.query(
            `INSERT INTO inventory_items (sku, quantity)
             VALUES ($1, $2)
             ON CONFLICT (sku) DO UPDATE SET quantity = EXCLUDED.quantity`,
            [item.sku, item.quantity]
          );
        }

        logger.info({ count: request.body.items.length }, 'Inventory seeded via API');
        return { message: 'Inventory seeded', count: request.body.items.length };
      } catch (err: any) {
        logger.error({ err }, 'Error seeding inventory');
        return reply.code(500).send({ error: err.message });
      }
    }
  );

  app.get('/inventory/:sku', async (request: FastifyRequest<{ Params: { sku: string } }>, reply: FastifyReply) => {
    try {
      const { sku } = request.params;
      const item = await inventoryRepo.findBySku(sku);

      if (!item) {
        return reply.code(404).send({ error: 'Inventory item not found' });
      }

      return {
        sku: item.sku,
        quantity: item.quantity,
        reservedQuantity: item.reservedQuantity,
        availableQuantity: item.quantity - item.reservedQuantity,
      };
    } catch (err: any) {
      logger.error({ err }, 'Error fetching inventory');
      return reply.code(500).send({ error: err.message });
    }
  });
}
