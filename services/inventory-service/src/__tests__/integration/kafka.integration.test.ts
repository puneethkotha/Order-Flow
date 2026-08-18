/**
 * End-to-end duplicate-delivery test on REAL Kafka (KRaft) + REAL Postgres.
 * The same ORDER_APPROVED event (identical eventId) is published twice, as the
 * at-least-once outbox would on a re-send. A real Kafka consumer drives the
 * real InventoryService, which deduplicates on the eventId inside its
 * transaction, so the reservation is applied exactly once.
 */
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { KafkaContainer, StartedKafkaContainer } from '@testcontainers/kafka';
import { Kafka, Consumer, Producer } from 'kafkajs';
import { v4 as uuidv4 } from 'uuid';

let pg: StartedPostgreSqlContainer;
let kafkaC: StartedKafkaContainer;
let kafka: Kafka;
let producer: Producer;
let consumer: Consumer;
/* eslint-disable @typescript-eslint/no-explicit-any */
let db: any;
let service: any;

const TOPIC = 'order.events';

async function reservedFor(sku: string): Promise<number> {
  const r = await db.query('SELECT reserved_quantity FROM inventory_items WHERE sku = $1', [sku]);
  return r.rows[0].reserved_quantity;
}

beforeAll(async () => {
  [pg, kafkaC] = await Promise.all([
    new PostgreSqlContainer('postgres:15-alpine').start(),
    new KafkaContainer('confluentinc/cp-kafka:7.5.0').withKraft().start(),
  ]);

  process.env.DATABASE_URL = pg.getConnectionUri();
  db = (await import('../../db/client')).db;
  const { migrations } = await import('../../db/migrations');
  for (const m of migrations) await db.query(m.up);
  await db.query(`INSERT INTO inventory_items (sku, quantity) VALUES ('SKU-K', 100)`);

  const { InventoryService } = await import('../../services/InventoryService');
  const { InventoryRepository } = await import('../../repositories/InventoryRepository');
  const { ReservationRepository } = await import('../../repositories/ReservationRepository');
  const { OutboxRepository } = await import('../../repositories/OutboxRepository');
  const { IdempotencyRepository } = await import('../../repositories/IdempotencyRepository');
  service = new InventoryService(
    new InventoryRepository(),
    new ReservationRepository(),
    new OutboxRepository(),
    new IdempotencyRepository()
  );

  const broker = `${kafkaC.getHost()}:${kafkaC.getMappedPort(9093)}`;
  kafka = new Kafka({ clientId: 'inv-it', brokers: [broker] });

  const admin = kafka.admin();
  await admin.connect();
  await admin.createTopics({ topics: [{ topic: TOPIC, numPartitions: 1 }], waitForLeaders: true });
  await admin.disconnect();

  producer = kafka.producer();
  consumer = kafka.consumer({ groupId: 'inv-it-group' });
  await producer.connect();
  await consumer.connect();
  await consumer.subscribe({ topic: TOPIC, fromBeginning: true });
  await consumer.run({
    eachMessage: async ({ message }) => {
      const event = JSON.parse(message.value?.toString() || '{}');
      if (event.eventType === 'ORDER_APPROVED') {
        await service.reserveInventory(event.payload.orderId, event.payload.items, event.eventId, event.correlationId);
      }
    },
  });
}, 240000);

afterAll(async () => {
  if (consumer) await consumer.disconnect();
  if (producer) await producer.disconnect();
  if (db) await db.close();
  await Promise.all([pg?.stop(), kafkaC?.stop()]);
});

it('applies a duplicated ORDER_APPROVED exactly once', async () => {
  const orderId = uuidv4();
  const eventId = uuidv4();
  const event = {
    eventId,
    eventType: 'ORDER_APPROVED',
    aggregateId: orderId,
    timestamp: new Date().toISOString(),
    correlationId: uuidv4(),
    version: 1,
    payload: { orderId, customerId: 'c1', total: 10, items: [{ sku: 'SKU-K', quantity: 4, price: 1 }] },
  };
  const value = JSON.stringify(event);

  // Publish the identical event twice (at-least-once duplicate).
  await producer.send({ topic: TOPIC, messages: [{ key: orderId, value }, { key: orderId, value }] });

  // Wait for the effect to settle, then confirm it was applied once.
  let reserved = 0;
  for (let i = 0; i < 40; i++) {
    reserved = await reservedFor('SKU-K');
    if (reserved >= 4) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  // Give any duplicate a chance to (wrongly) double-apply before asserting.
  await new Promise((r) => setTimeout(r, 1000));
  expect(await reservedFor('SKU-K')).toBe(4);
}, 60000);
