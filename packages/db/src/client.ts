import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { Pool } from 'pg';
import * as schema from './schema.js';

export type WatchrailDatabase = NodePgDatabase<typeof schema> & { $client: Pool };

export interface DatabaseConnection {
  db: WatchrailDatabase;
  pool: Pool;
}

export function createWatchrailDatabase(databaseUrl: string): WatchrailDatabase {
  return drizzle({ connection: databaseUrl, schema });
}

export function createDatabaseConnection(databaseUrl: string): DatabaseConnection {
  const db = createWatchrailDatabase(databaseUrl);
  return { db, pool: db.$client };
}
