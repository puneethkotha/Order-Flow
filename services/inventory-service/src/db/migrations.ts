export const migrations = [
  {
    version: 1,
    name: 'create_inventory_items_table',
    up: `
      CREATE TABLE IF NOT EXISTS inventory_items (
        sku VARCHAR(255) PRIMARY KEY,
        quantity INTEGER NOT NULL DEFAULT 0,
        reserved_quantity INTEGER NOT NULL DEFAULT 0,
        created_at TIMESTAMP NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMP NOT NULL DEFAULT NOW()
      );

      CREATE INDEX idx_inventory_items_quantity ON inventory_items(quantity);
    `,
    down: `DROP TABLE IF EXISTS inventory_items;`,
  },
  {
    version: 2,
    name: 'create_inventory_reservations_table',
    up: `
      CREATE TABLE IF NOT EXISTS inventory_reservations (
        id UUID PRIMARY KEY,
        order_id UUID NOT NULL,
        sku VARCHAR(255) NOT NULL REFERENCES inventory_items(sku),
        quantity INTEGER NOT NULL,
        status VARCHAR(50) NOT NULL,
        created_at TIMESTAMP NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMP NOT NULL DEFAULT NOW()
      );

      CREATE INDEX idx_inventory_reservations_order_id ON inventory_reservations(order_id);
      CREATE INDEX idx_inventory_reservations_sku ON inventory_reservations(sku);
      CREATE INDEX idx_inventory_reservations_status ON inventory_reservations(status);
    `,
    down: `DROP TABLE IF EXISTS inventory_reservations;`,
  },
  {
    version: 3,
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
    version: 4,
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
    version: 5,
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
];
