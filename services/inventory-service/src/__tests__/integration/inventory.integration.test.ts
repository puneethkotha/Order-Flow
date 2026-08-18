/**
 * Integration tests for inventory-service compensation against a REAL Postgres.
 * Verifies:
 *   - releasing a reservation returns reserved stock to baseline (invariant I4,
 *     the permanent-stock-leak fix),
 *   - a re-delivered ORDER_APPROVED (same eventId) does not double-reserve
 *     (invariant I7, the offset-keyed duplicate fix),
 *   - a short order rolls back partial reservations.
 */
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { v4 as uuidv4 } from 'uuid';

let pg: StartedPostgreSqlContainer;
/* eslint-disable @typescript-eslint/no-explicit-any */
let db: any;
let InventoryService: any;
let InventoryRepository: any;
let ReservationRepository: any;
let OutboxRepository: any;
let IdempotencyRepository: any;
let service: any;
let inventoryRepo: any;

async function reservedFor(sku: string): Promise<number> {
  const r = await db.query('SELECT reserved_quantity FROM inventory_items WHERE sku = $1', [sku]);
  return r.rows[0].reserved_quantity;
}

beforeAll(async () => {
  pg = await new PostgreSqlContainer('postgres:15-alpine').start();
  process.env.DATABASE_URL = pg.getConnectionUri();

  db = (await import('../../db/client')).db;
  const { migrations } = await import('../../db/migrations');
  for (const m of migrations) await db.query(m.up);

  ({ InventoryService } = await import('../../services/InventoryService'));
  ({ InventoryRepository } = await import('../../repositories/InventoryRepository'));
  ({ ReservationRepository } = await import('../../repositories/ReservationRepository'));
  ({ OutboxRepository } = await import('../../repositories/OutboxRepository'));
  ({ IdempotencyRepository } = await import('../../repositories/IdempotencyRepository'));

  inventoryRepo = new InventoryRepository();
  service = new InventoryService(
    inventoryRepo,
    new ReservationRepository(),
    new OutboxRepository(),
    new IdempotencyRepository()
  );

  await db.query(
    `INSERT INTO inventory_items (sku, quantity) VALUES ('SKU-A', 100), ('SKU-B', 100)
     ON CONFLICT (sku) DO UPDATE SET quantity = EXCLUDED.quantity`
  );
}, 240000);

afterAll(async () => {
  if (db) await db.close();
  if (pg) await pg.stop();
});

describe('reservation release (no stock leak, I4)', () => {
  it('returns reserved stock to baseline after release', async () => {
    const orderId = uuidv4();
    const before = await reservedFor('SKU-A');
    await service.reserveInventory(orderId, [{ sku: 'SKU-A', quantity: 5, price: 1 }], uuidv4(), uuidv4());
    expect(await reservedFor('SKU-A')).toBe(before + 5);

    await service.releaseReservation(orderId, uuidv4(), uuidv4());
    expect(await reservedFor('SKU-A')).toBe(before); // baseline restored
  });
});

describe('duplicate delivery (no double-reserve, I7)', () => {
  it('a re-delivered ORDER_APPROVED with the same eventId reserves once', async () => {
    const orderId = uuidv4();
    const eventId = uuidv4();
    const before = await reservedFor('SKU-B');
    await service.reserveInventory(orderId, [{ sku: 'SKU-B', quantity: 3, price: 1 }], eventId, uuidv4());
    // Re-deliver the same business event (new transport offset, same eventId).
    await service.reserveInventory(orderId, [{ sku: 'SKU-B', quantity: 3, price: 1 }], eventId, uuidv4());
    expect(await reservedFor('SKU-B')).toBe(before + 3); // reserved once, not twice
  });
});

describe('partial failure rollback', () => {
  it('reserves nothing when any line item is short', async () => {
    const orderId = uuidv4();
    const beforeA = await reservedFor('SKU-A');
    await service.reserveInventory(
      orderId,
      [
        { sku: 'SKU-A', quantity: 1, price: 1 },
        { sku: 'SKU-A', quantity: 1_000_000, price: 1 }, // impossible
      ],
      uuidv4(),
      uuidv4()
    );
    expect(await reservedFor('SKU-A')).toBe(beforeA); // partial reservation rolled back
  });
});
