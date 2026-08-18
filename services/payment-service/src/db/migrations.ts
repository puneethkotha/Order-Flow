export const migrations = [
  {
    version: 1,
    name: 'create_payments_table',
    up: `
      CREATE TABLE IF NOT EXISTS payments (
        id UUID PRIMARY KEY,
        order_id UUID NOT NULL,
        amount DECIMAL(10, 2) NOT NULL,
        status VARCHAR(50) NOT NULL,
        idempotency_key VARCHAR(255) NOT NULL UNIQUE,
        created_at TIMESTAMP NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMP NOT NULL DEFAULT NOW()
      );

      CREATE INDEX idx_payments_order_id ON payments(order_id);
      CREATE INDEX idx_payments_idempotency_key ON payments(idempotency_key);
      CREATE INDEX idx_payments_status ON payments(status);
    `,
    down: `DROP TABLE IF EXISTS payments;`,
  },
  {
    version: 2,
    name: 'create_processed_messages_table',
    up: `
      CREATE TABLE IF NOT EXISTS processed_messages (
        message_id VARCHAR(255) PRIMARY KEY,
        processed_at TIMESTAMP NOT NULL DEFAULT NOW()
      );

      CREATE INDEX idx_processed_messages_processed_at ON processed_messages(processed_at);
    `,
    down: `DROP TABLE IF EXISTS processed_messages;`,
  },
  {
    version: 3,
    name: 'create_outbox_table',
    up: `
      CREATE TABLE IF NOT EXISTS outbox (
        id UUID PRIMARY KEY,
        aggregate_id UUID NOT NULL,
        topic VARCHAR(255) NOT NULL,
        key VARCHAR(255) NOT NULL,
        payload JSONB NOT NULL,
        status VARCHAR(50) NOT NULL DEFAULT 'PENDING',
        created_at TIMESTAMP NOT NULL DEFAULT NOW(),
        delivered_at TIMESTAMP
      );

      CREATE INDEX idx_outbox_status ON outbox(status);
      CREATE INDEX idx_outbox_created_at ON outbox(created_at);
    `,
    down: `DROP TABLE IF EXISTS outbox;`,
  },
  {
    version: 4,
    name: 'create_migrations_table',
    up: `
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        applied_at TIMESTAMP NOT NULL DEFAULT NOW()
      );
    `,
    down: `DROP TABLE IF EXISTS schema_migrations;`,
  },
  {
    version: 5,
    name: 'create_payment_ledger_table',
    up: `
      CREATE TABLE IF NOT EXISTS payment_ledger (
        id UUID PRIMARY KEY,
        order_id UUID NOT NULL,
        payment_id UUID NOT NULL,
        kind VARCHAR(50) NOT NULL,
        amount DECIMAL(10, 2) NOT NULL,
        created_at TIMESTAMP NOT NULL DEFAULT NOW()
      );

      CREATE INDEX idx_payment_ledger_order_id ON payment_ledger(order_id);
      CREATE INDEX idx_payment_ledger_kind ON payment_ledger(kind);
    `,
    down: `DROP TABLE IF EXISTS payment_ledger;`,
  },
];
