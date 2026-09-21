import { resolve } from 'node:path';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { createDatabaseConnection, type DatabaseConnection } from './client.js';
import { migrateDatabase } from './migration.js';

describe('database migrations', () => {
  let container: StartedPostgreSqlContainer;
  let connection: DatabaseConnection;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:18.0-alpine').start();
    connection = createDatabaseConnection(container.getConnectionUri());
  }, 60_000);

  afterAll(async () => {
    await connection?.pool.end();
    await container?.stop();
  });

  it('builds the expected schema from an empty database', async () => {
    await migrateDatabase(connection, resolve(process.cwd(), 'drizzle'));

    const result = await connection.db.execute<{ table_name: string }>(sql`
      select table_name
      from information_schema.tables
      where table_schema = 'public' and table_name = 'monitors'
    `);

    expect(result.rows).toEqual([{ table_name: 'monitors' }]);
  });
});
