/**
 * Integration tests for payment-service capture and compensation against a REAL
 * Postgres. Verifies:
 *   - an authorized payment can be captured (and capture is idempotent),
 *   - cancelling an authorized-but-uncaptured payment voids it (invariant I5,
 *     the held-authorization fix),
 *   - cancelling a captured payment refunds it,
 *   - the payment_ledger records each action once.
 */
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { v4 as uuidv4 } from 'uuid';

let pg: StartedPostgreSqlContainer;
/* eslint-disable @typescript-eslint/no-explicit-any */
let db: any;
let PaymentService: any;
let PaymentRepository: any;
let OutboxRepository: any;
let IdempotencyRepository: any;
let service: any;
let randomSpy: jest.SpyInstance;

async function ledgerKinds(orderId: string): Promise<string[]> {
  const r = await db.query('SELECT kind FROM payment_ledger WHERE order_id = $1 ORDER BY created_at', [orderId]);
  return r.rows.map((row: any) => row.kind);
}

async function statusOf(orderId: string): Promise<string> {
  const r = await db.query('SELECT status FROM payments WHERE order_id = $1', [orderId]);
  return r.rows[0].status;
}

async function authorize(orderId: string): Promise<void> {
  await service.authorizePayment(orderId, 42, `order-${orderId}`, uuidv4());
}

beforeAll(async () => {
  pg = await new PostgreSqlContainer('postgres:15-alpine').start();
  process.env.DATABASE_URL = pg.getConnectionUri();

  db = (await import('../../db/client')).db;
  const { migrations } = await import('../../db/migrations');
  for (const m of migrations) await db.query(m.up);

  ({ PaymentService } = await import('../../services/PaymentService'));
  ({ PaymentRepository } = await import('../../repositories/PaymentRepository'));
  ({ OutboxRepository } = await import('../../repositories/OutboxRepository'));
  ({ IdempotencyRepository } = await import('../../repositories/IdempotencyRepository'));

  service = new PaymentService(new PaymentRepository(), new OutboxRepository(), new IdempotencyRepository());
  // Force the simulated gateway to always authorize.
  randomSpy = jest.spyOn(Math, 'random').mockReturnValue(0.99);
}, 240000);

afterAll(async () => {
  if (randomSpy) randomSpy.mockRestore();
  if (db) await db.close();
  if (pg) await pg.stop();
});

describe('capture', () => {
  it('captures an authorized payment, idempotently', async () => {
    const orderId = uuidv4();
    await authorize(orderId);
    expect(await statusOf(orderId)).toBe('AUTHORIZED');

    const eventId = uuidv4();
    await service.capturePayment(orderId, eventId, uuidv4());
    await service.capturePayment(orderId, eventId, uuidv4()); // duplicate, same eventId
    expect(await statusOf(orderId)).toBe('CAPTURED');
    expect(await ledgerKinds(orderId)).toEqual(['CAPTURE']); // captured once
  });
});

describe('compensation (held-authorization fix, I5)', () => {
  it('voids an authorized-but-uncaptured payment on cancel', async () => {
    const orderId = uuidv4();
    await authorize(orderId);
    await service.compensate(orderId, uuidv4(), uuidv4());
    expect(await statusOf(orderId)).toBe('VOIDED');
    expect(await ledgerKinds(orderId)).toEqual(['VOID']);
  });

  it('refunds a captured payment on cancel', async () => {
    const orderId = uuidv4();
    await authorize(orderId);
    await service.capturePayment(orderId, uuidv4(), uuidv4());
    await service.compensate(orderId, uuidv4(), uuidv4());
    expect(await statusOf(orderId)).toBe('REFUNDED');
    expect(await ledgerKinds(orderId)).toEqual(['CAPTURE', 'REFUND']);
  });
});
