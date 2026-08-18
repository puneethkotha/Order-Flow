import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { InventoryService } from '../services/InventoryService';
import { InventoryRepository } from '../repositories/InventoryRepository';
import { db } from '../db/client';
import { logger } from '../utils/logger';
import { register, httpRequests } from '../metrics';

export function registerRoutes(app: FastifyInstance, inventoryService: InventoryService, inventoryRepo: InventoryRepository): void {
  app.addHook('onResponse', async (request, reply) => {
    httpRequests.inc({
      method: request.method,
      route: request.routeOptions?.url ?? request.url,
      status: String(reply.statusCode),
    });
  });

  app.get('/health', async () => {
    return { status: 'healthy', service: 'inventory-service', timestamp: new Date().toISOString() };
  });

  app.get('/metrics', async (_request: FastifyRequest, reply: FastifyReply) => {
    reply.header('Content-Type', register.contentType);
    return register.metrics();
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
