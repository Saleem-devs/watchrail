import { migrate } from 'drizzle-orm/node-postgres/migrator';
import type { DatabaseConnection } from './client.js';

export function migrateDatabase(
  connection: DatabaseConnection,
  migrationsFolder: string,
): Promise<void> {
  return migrate(connection.db, { migrationsFolder });
}
