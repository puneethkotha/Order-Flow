import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { OrderService } from '../services/OrderService';
import { OrderItem } from '@orderflow/shared';
import { logger } from '../utils/logger';
import { register, httpRequests } from '../metrics';

interface CreateOrderBody {
  customerId: string;
  items: OrderItem[];
}

interface ApproveOrderParams {
  id: string;
}

export function registerRoutes(app: FastifyInstance, orderService: OrderService): void {
  // Count every response by method, route, and status.
  app.addHook('onResponse', async (request, reply) => {
    httpRequests.inc({
      method: request.method,
      route: request.routeOptions?.url ?? request.url,
      status: String(reply.statusCode),
    });
  });

  // Health check
  app.get('/health', async () => {
    return { status: 'healthy', service: 'order-service', timestamp: new Date().toISOString() };
  });

  // Prometheus metrics
  app.get('/metrics', async (_request: FastifyRequest, reply: FastifyReply) => {
    reply.header('Content-Type', register.contentType);
    return register.metrics();
  });

  // Create order
  app.post('/orders', async (request: FastifyRequest<{ Body: CreateOrderBody }>, reply: FastifyReply) => {
    try {
      const { customerId, items } = request.body;

      if (!customerId || !items || items.length === 0) {
        return reply.code(400).send({ error: 'customerId and items are required' });
      }

      const order = await orderService.createOrder(customerId, items);
      logger.info({ orderId: order.id }, 'Order created via API');

      return reply.code(201).send({
        id: order.id,
        customerId: order.customerId,
        state: order.state,
        total: order.total,
        items: order.items,
        createdAt: order.createdAt,
      });
    } catch (err: any) {
      logger.error({ err }, 'Error creating order');
      return reply.code(500).send({ error: err.message });
    }
  });

  // Approve order
  app.post(
    '/orders/:id/approve',
    async (request: FastifyRequest<{ Params: ApproveOrderParams }>, reply: FastifyReply) => {
      try {
        const { id } = request.params;
        await orderService.approveOrder(id);
        logger.info({ orderId: id }, 'Order approved via API');
        return { message: 'Order approved', orderId: id };
      } catch (err: any) {
        logger.error({ err, orderId: request.params.id }, 'Error approving order');
        return reply.code(500).send({ error: err.message });
      }
    }
  );

  // Ship order
  app.post(
    '/orders/:id/ship',
    async (request: FastifyRequest<{ Params: ApproveOrderParams }>, reply: FastifyReply) => {
      try {
        const { id } = request.params;
        await orderService.shipOrder(id);
        logger.info({ orderId: id }, 'Order shipped via API');
        return { message: 'Order shipped', orderId: id };
      } catch (err: any) {
        logger.error({ err, orderId: request.params.id }, 'Error shipping order');
        return reply.code(500).send({ error: err.message });
      }
    }
  );

  // Complete order
  app.post(
    '/orders/:id/complete',
    async (request: FastifyRequest<{ Params: ApproveOrderParams }>, reply: FastifyReply) => {
      try {
        const { id } = request.params;
        await orderService.completeOrder(id);
        logger.info({ orderId: id }, 'Order completed via API');
        return { message: 'Order completed', orderId: id };
      } catch (err: any) {
        logger.error({ err, orderId: request.params.id }, 'Error completing order');
        return reply.code(500).send({ error: err.message });
      }
    }
  );

  // Cancel order
  app.post(
    '/orders/:id/cancel',
    async (
      request: FastifyRequest<{ Params: ApproveOrderParams; Body: { reason: string } }>,
      reply: FastifyReply
    ) => {
      try {
        const { id } = request.params;
        const { reason } = request.body;
        await orderService.cancelOrder(id, reason || 'Manual cancellation', 'MANUAL_CANCEL');
        logger.info({ orderId: id }, 'Order cancelled via API');
        return { message: 'Order cancelled', orderId: id };
      } catch (err: any) {
        logger.error({ err, orderId: request.params.id }, 'Error cancelling order');
        return reply.code(500).send({ error: err.message });
      }
    }
  );

  // Get order by ID
  app.get(
    '/orders/:id',
    async (request: FastifyRequest<{ Params: ApproveOrderParams }>, reply: FastifyReply) => {
      try {
        const { id } = request.params;
        const order = await orderService.getOrder(id);

        if (!order) {
          return reply.code(404).send({ error: 'Order not found' });
        }

        return {
          id: order.id,
          customerId: order.customerId,
          state: order.state,
          total: order.total,
          items: order.items,
          version: order.version,
          createdAt: order.createdAt,
          updatedAt: order.updatedAt,
        };
      } catch (err: any) {
        logger.error({ err, orderId: request.params.id }, 'Error fetching order');
        return reply.code(500).send({ error: err.message });
      }
    }
  );

  // Get orders by customer
  app.get(
    '/orders',
    async (request: FastifyRequest<{ Querystring: { customerId: string } }>, reply: FastifyReply) => {
      try {
        const { customerId } = request.query;

        if (!customerId) {
          return reply.code(400).send({ error: 'customerId query parameter is required' });
        }

        const orders = await orderService.getOrdersByCustomer(customerId);

        return orders.map((order) => ({
          id: order.id,
          customerId: order.customerId,
          state: order.state,
          total: order.total,
          items: order.items,
          version: order.version,
          createdAt: order.createdAt,
          updatedAt: order.updatedAt,
        }));
      } catch (err: any) {
        logger.error({ err }, 'Error fetching orders');
        return reply.code(500).send({ error: err.message });
      }
    }
  );
}
