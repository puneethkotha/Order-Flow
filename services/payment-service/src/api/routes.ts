import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { PaymentService } from '../services/PaymentService';
import { logger } from '../utils/logger';

interface AuthorizePaymentBody {
  orderId: string;
  amount: number;
}

export function registerRoutes(app: FastifyInstance, paymentService: PaymentService): void {
  app.get('/health', async (request: FastifyRequest, reply: FastifyReply) => {
    return { status: 'healthy', service: 'payment-service', timestamp: new Date().toISOString() };
  });

  app.get('/metrics', async (request: FastifyRequest, reply: FastifyReply) => {
    return { message: 'Metrics endpoint - integrate prom-client here' };
  });

  app.post(
    '/payments/authorize',
    async (request: FastifyRequest<{ Body: AuthorizePaymentBody }>, reply: FastifyReply) => {
      try {
        const { orderId, amount } = request.body;
        const idempotencyKey = request.headers['idempotency-key'] as string;

        if (!orderId || !amount) {
          return reply.code(400).send({ error: 'orderId and amount are required' });
        }

        if (!idempotencyKey) {
          return reply.code(400).send({ error: 'Idempotency-Key header is required' });
        }

        const payment = await paymentService.authorizePayment(orderId, amount, idempotencyKey);

        logger.info({ paymentId: payment.id, orderId }, 'Payment authorized via API');

        return reply.code(payment.status === 'AUTHORIZED' ? 200 : 402).send({
          id: payment.id,
          orderId: payment.orderId,
          amount: payment.amount,
          status: payment.status,
          createdAt: payment.createdAt,
        });
      } catch (err: any) {
        logger.error({ err }, 'Error authorizing payment');
        return reply.code(500).send({ error: err.message });
      }
    }
  );
}
