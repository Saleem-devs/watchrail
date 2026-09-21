import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from './schema.js';

export type WatchrailDatabase = NodePgDatabase<typeof schema>;

export interface DatabaseConnection {
  db: WatchrailDatabase;
  pool: Pool;
}

export function createDatabaseConnection(databaseUrl: string): DatabaseConnection {
  const pool = new Pool({ connectionString: databaseUrl, max: 10 });
  return { pool, db: drizzle(pool, { schema }) };
}
