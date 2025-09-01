import { db } from './client';
import { migrations } from './migrations';
import { logger } from '../utils/logger';

async function migrate() {
  try {
    logger.info('Starting migrations...');

    // Ensure migrations table exists
    const migrationTableMigration = migrations.find((m) => m.name === 'create_migrations_table');
    if (migrationTableMigration) {
      await db.query(migrationTableMigration.up);
    }

    // Get applied migrations
    const result = await db.query('SELECT version FROM schema_migrations ORDER BY version');
    const appliedVersions = new Set(result.rows.map((row: any) => row.version));

    // Apply pending migrations
    for (const migration of migrations) {
      if (!appliedVersions.has(migration.version) && migration.name !== 'create_migrations_table') {
        logger.info({ version: migration.version, name: migration.name }, 'Applying migration');
        await db.query(migration.up);
        await db.query(
          'INSERT INTO schema_migrations (version, name) VALUES ($1, $2)',
          [migration.version, migration.name]
        );
        logger.info({ version: migration.version, name: migration.name }, 'Migration applied');
      }
    }

    logger.info('All migrations completed');
    process.exit(0);
  } catch (err) {
    logger.error({ err }, 'Migration failed');
    process.exit(1);
  }
}

migrate();
