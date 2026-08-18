import Fastify from 'fastify';
import cors from '@fastify/cors';
import { Kafka } from 'kafkajs';
import { config } from './config';
import { logger } from './utils/logger';
import { db } from './db/client';
import { kafkaProducer } from './kafka/producer';
import { OutboxPublisher } from './kafka/outbox-publisher';
import { OrderEventConsumer } from './kafka/order-consumer';
import { InventoryService } from './services/InventoryService';
import { InventoryRepository } from './repositories/InventoryRepository';
import { ReservationRepository } from './repositories/ReservationRepository';
import { OutboxRepository } from './repositories/OutboxRepository';
import { IdempotencyRepository } from './repositories/IdempotencyRepository';
import { registerRoutes } from './api/routes';

async function bootstrap() {
  const app = Fastify({ logger: false });
  await app.register(cors);

  const inventoryRepo = new InventoryRepository();
  const reservationRepo = new ReservationRepository();
  const outboxRepo = new OutboxRepository();
  const idempotencyRepo = new IdempotencyRepository();

  const inventoryService = new InventoryService(inventoryRepo, reservationRepo, outboxRepo, idempotencyRepo);

  registerRoutes(app, inventoryService, inventoryRepo);

  const dbHealthy = await db.healthCheck();
  if (!dbHealthy) {
    logger.error('Database health check failed');
    process.exit(1);
  }

  await kafkaProducer.connect();

  const outboxPublisher = new OutboxPublisher(outboxRepo, 1000);
  outboxPublisher.start();

  const kafka = new Kafka({
    clientId: config.kafka.clientId,
    brokers: config.kafka.brokers,
  });

  const orderConsumer = kafka.consumer({
    groupId: config.kafka.groupId,
    sessionTimeout: 30000,
    heartbeatInterval: 3000,
  });

  const orderEventConsumer = new OrderEventConsumer(orderConsumer, inventoryService);
  await orderEventConsumer.start();

  try {
    await app.listen({ port: config.port, host: '0.0.0.0' });
    logger.info({ port: config.port }, 'Inventory service started');
  } catch (err) {
    logger.error({ err }, 'Failed to start server');
    process.exit(1);
  }

  const shutdown = async () => {
    logger.info('Shutting down inventory service...');
    outboxPublisher.stop();
    await orderEventConsumer.stop();
    await kafkaProducer.disconnect();
    await db.close();
    await app.close();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

bootstrap().catch((err) => {
  logger.error({ err }, 'Failed to bootstrap inventory service');
  process.exit(1);
});
