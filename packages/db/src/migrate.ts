import { resolve } from 'node:path';
import { config } from 'dotenv';
import { createDatabaseConnection } from './client.js';
import { migrateDatabase } from './migration.js';

config({ path: resolve(process.cwd(), '../../.env') });

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required to run migrations.');

const connection = createDatabaseConnection(databaseUrl);

try {
  await migrateDatabase(connection, resolve(process.cwd(), 'drizzle'));
  console.log('Database migrations applied.');
} finally {
  await connection.pool.end();
}
