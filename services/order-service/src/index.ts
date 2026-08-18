import Fastify from 'fastify';
import cors from '@fastify/cors';
import { Kafka } from 'kafkajs';
import { config } from './config';
import { logger } from './utils/logger';
import { db } from './db/client';
import { kafkaProducer } from './kafka/producer';
import { OutboxPublisher } from './kafka/outbox-publisher';
import { PaymentEventConsumer } from './kafka/consumers/payment-consumer';
import { InventoryEventConsumer } from './kafka/consumers/inventory-consumer';
import { OrderService } from './services/OrderService';
import { OrderRepository } from './repositories/OrderRepository';
import { OutboxRepository } from './repositories/OutboxRepository';
import { EventRepository } from './repositories/EventRepository';
import { StateTrackingRepository } from './repositories/StateTrackingRepository';
import { IdempotencyRepository } from './repositories/IdempotencyRepository';
import { registerRoutes } from './api/routes';

async function bootstrap() {
  // Initialize Fastify
  const app = Fastify({ logger: false });
  await app.register(cors);

  // Initialize repositories
  const orderRepo = new OrderRepository();
  const outboxRepo = new OutboxRepository();
  const eventRepo = new EventRepository();
  const stateTrackingRepo = new StateTrackingRepository();
  const idempotencyRepo = new IdempotencyRepository();

  // Initialize service
  const orderService = new OrderService(
    orderRepo,
    outboxRepo,
    eventRepo,
    stateTrackingRepo,
    idempotencyRepo
  );

  // Register routes
  registerRoutes(app, orderService);

  // Check database health
  const dbHealthy = await db.healthCheck();
  if (!dbHealthy) {
    logger.error('Database health check failed');
    process.exit(1);
  }

  // Connect Kafka producer
  await kafkaProducer.connect();

  // Start outbox publisher
  const outboxPublisher = new OutboxPublisher(outboxRepo, 1000);
  outboxPublisher.start();

  // Initialize Kafka consumers
  const kafka = new Kafka({
    clientId: config.kafka.clientId,
    brokers: config.kafka.brokers,
  });

  const paymentConsumer = kafka.consumer({
    groupId: `${config.kafka.groupId}-payment`,
    sessionTimeout: 30000,
    heartbeatInterval: 3000,
  });

  const inventoryConsumer = kafka.consumer({
    groupId: `${config.kafka.groupId}-inventory`,
    sessionTimeout: 30000,
    heartbeatInterval: 3000,
  });

  const paymentEventConsumer = new PaymentEventConsumer(paymentConsumer, orderService);

  const inventoryEventConsumer = new InventoryEventConsumer(inventoryConsumer, orderService);

  await paymentEventConsumer.start();
  await inventoryEventConsumer.start();

  // Start HTTP server
  try {
    await app.listen({ port: config.port, host: '0.0.0.0' });
    logger.info({ port: config.port }, 'Order service started');
  } catch (err) {
    logger.error({ err }, 'Failed to start server');
    process.exit(1);
  }

  // Graceful shutdown
  const shutdown = async () => {
    logger.info('Shutting down order service...');
    outboxPublisher.stop();
    await paymentEventConsumer.stop();
    await inventoryEventConsumer.stop();
    await kafkaProducer.disconnect();
    await db.close();
    await app.close();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

bootstrap().catch((err) => {
  logger.error({ err }, 'Failed to bootstrap order service');
  process.exit(1);
});
