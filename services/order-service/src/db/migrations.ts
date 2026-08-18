export const migrations = [
  {
    version: 1,
    name: 'create_orders_table',
    up: `
      CREATE TABLE IF NOT EXISTS orders (
        id UUID PRIMARY KEY,
        customer_id VARCHAR(255) NOT NULL,
        state VARCHAR(50) NOT NULL,
        total DECIMAL(10, 2) NOT NULL,
        items JSONB NOT NULL,
        version INTEGER NOT NULL DEFAULT 1,
        created_at TIMESTAMP NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMP NOT NULL DEFAULT NOW()
      );

      CREATE INDEX idx_orders_customer_id ON orders(customer_id);
      CREATE INDEX idx_orders_state ON orders(state);
      CREATE INDEX idx_orders_created_at ON orders(created_at);
    `,
    down: `DROP TABLE IF EXISTS orders;`,
  },
  {
    version: 2,
    name: 'create_order_events_table',
    up: `
      CREATE TABLE IF NOT EXISTS order_events (
        id UUID PRIMARY KEY,
        order_id UUID NOT NULL REFERENCES orders(id),
        event_type VARCHAR(100) NOT NULL,
        payload JSONB NOT NULL,
        created_at TIMESTAMP NOT NULL DEFAULT NOW()
      );

      CREATE INDEX idx_order_events_order_id ON order_events(order_id);
      CREATE INDEX idx_order_events_created_at ON order_events(created_at);
    `,
    down: `DROP TABLE IF EXISTS order_events;`,
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
    version: 5,
    name: 'create_order_state_tracking_table',
    up: `
      CREATE TABLE IF NOT EXISTS order_state_tracking (
        order_id UUID PRIMARY KEY REFERENCES orders(id),
        payment_authorized BOOLEAN NOT NULL DEFAULT FALSE,
        inventory_reserved BOOLEAN NOT NULL DEFAULT FALSE,
        updated_at TIMESTAMP NOT NULL DEFAULT NOW()
      );

      CREATE INDEX idx_order_state_tracking_updated_at ON order_state_tracking(updated_at);
    `,
    down: `DROP TABLE IF EXISTS order_state_tracking;`,
  },
  {
    version: 6,
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
    version: 7,
    name: 'add_payment_captured_to_state_tracking',
    up: `
      ALTER TABLE order_state_tracking
        ADD COLUMN IF NOT EXISTS payment_captured BOOLEAN NOT NULL DEFAULT FALSE;
    `,
    down: `ALTER TABLE order_state_tracking DROP COLUMN IF EXISTS payment_captured;`,
  },
];
