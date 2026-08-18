/**
 * Integration tests for the order-service correctness fixes against a REAL
 * Postgres (Testcontainers). Verifies:
 *   - the coordinator join reaches FULFILLING under concurrent handlers (the
 *     stuck-saga race fix: client reads + SELECT ... FOR UPDATE),
 *   - optimistic concurrency rejects a stale update,
 *   - eventId idempotency is atomic and deduplicates.
 *
 * DATABASE_URL is set to the container before the service modules are imported,
 * so the real db singleton, repositories, and OrderService run against it.
 */
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { v4 as uuidv4 } from 'uuid';

let pg: StartedPostgreSqlContainer;
/* eslint-disable @typescript-eslint/no-explicit-any */
let db: any;
let OrderService: any;
let OrderRepository: any;
let OptimisticLockError: any;
let OutboxRepository: any;
let EventRepository: any;
let StateTrackingRepository: any;
let IdempotencyRepository: any;
let OrderAggregate: any;
let orderService: any;

beforeAll(async () => {
  pg = await new PostgreSqlContainer('postgres:15-alpine').start();
  process.env.DATABASE_URL = pg.getConnectionUri();

  db = (await import('../../db/client')).db;
  const { migrations } = await import('../../db/migrations');
  for (const m of migrations) {
    await db.query(m.up);
  }

  ({ OrderService } = await import('../../services/OrderService'));
  ({ OrderRepository, OptimisticLockError } = await import('../../repositories/OrderRepository'));
  ({ OutboxRepository } = await import('../../repositories/OutboxRepository'));
  ({ EventRepository } = await import('../../repositories/EventRepository'));
  ({ StateTrackingRepository } = await import('../../repositories/StateTrackingRepository'));
  ({ IdempotencyRepository } = await import('../../repositories/IdempotencyRepository'));
  ({ OrderAggregate } = await import('../../domain/OrderAggregate'));

  orderService = new OrderService(
    new OrderRepository(),
    new OutboxRepository(),
    new EventRepository(),
    new StateTrackingRepository(),
    new IdempotencyRepository()
  );
}, 240000);

afterAll(async () => {
  if (db) await db.close();
  if (pg) await pg.stop();
});

async function createApproved(): Promise<string> {
  const order = await orderService.createOrder('cust-1', [{ sku: 'SKU-A', quantity: 1, price: 10 }]);
  await orderService.approveOrder(order.id);
  return order.id;
}

describe('coordinator join under concurrency (stuck-saga race fix)', () => {
  it('reaches FULFILLING when both handlers run concurrently, across many orders', async () => {
    const ids = await Promise.all(Array.from({ length: 25 }, () => createApproved()));

    // Fire the payment and inventory handlers concurrently for each order.
    await Promise.all(
      ids.map((id) =>
        Promise.all([
          orderService.handlePaymentAuthorized(id, uuidv4(), uuidv4()),
          orderService.handleInventoryReserved(id, uuidv4(), uuidv4()),
        ])
      )
    );

    for (const id of ids) {
      const order = await orderService.getOrder(id);
      expect(order.state).toBe('FULFILLING');
    }
  });
});

describe('optimistic concurrency', () => {
  it('rejects a stale update with OptimisticLockError', async () => {
    const repo = new OrderRepository();
    const order = OrderAggregate.create('cust-2', [{ sku: 'SKU-A', quantity: 1, price: 10 }]);
    await repo.save(order); // version 1 insert

    // Two aggregates both advance from version 1 to version 2.
    const a = await repo.findById(order.id);
    const b = await repo.findById(order.id);
    a.approve();
    b.approve();

    await repo.save(a); // succeeds: stored 1 -> 2
    await expect(repo.save(b)).rejects.toThrow(OptimisticLockError); // stale
  });
});

describe('eventId idempotency', () => {
  it('claim returns true once then false for the same eventId', async () => {
    const repo = new IdempotencyRepository();
    const eventId = uuidv4();
    const first = await db.transaction((c: any) => repo.claim(eventId, c));
    const second = await db.transaction((c: any) => repo.claim(eventId, c));
    expect(first).toBe(true);
    expect(second).toBe(false);
  });

  it('a duplicated PAYMENT_AUTHORIZED is applied once', async () => {
    const id = await createApproved();
    const eventId = uuidv4();
    await orderService.handlePaymentAuthorized(id, eventId, uuidv4());
    // Re-deliver the same business event (new transport, same eventId).
    await orderService.handlePaymentAuthorized(id, eventId, uuidv4());

    const tracking = await new StateTrackingRepository().findByOrderId(id);
    expect(tracking.paymentAuthorized).toBe(true);
    // Still APPROVED (inventory not reserved yet); no double transition.
    const order = await orderService.getOrder(id);
    expect(order.state).toBe('APPROVED');
  });
});
