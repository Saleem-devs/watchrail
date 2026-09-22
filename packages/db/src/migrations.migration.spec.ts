import { resolve } from 'node:path';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { sql } from 'drizzle-orm';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { createDatabaseConnection, type DatabaseConnection } from './client.js';

const existingMonitor = {
  id: '11111111-1111-4111-8111-111111111111',
  organizationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
} as const;

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

  it('upgrades the existing schema and backfills immutable monitor configuration', async () => {
    const migrations = readMigrationFiles({
      migrationsFolder: resolve(process.cwd(), 'drizzle'),
    });

    await applyMigration(migrations, 0);

    await connection.db.execute(sql`
      insert into monitors (id, organization_id, name, url)
      values (
        ${existingMonitor.id},
        ${existingMonitor.organizationId},
        'Existing monitor',
        'https://example.com/health'
      )
    `);

    await applyMigration(migrations, 1);

    const result = await connection.db.execute<{
      table_name: string;
    }>(sql`
      select table_name
      from information_schema.tables
      where table_schema = 'public'
        and table_name in (
          'monitors',
          'monitor_configuration_versions',
          'check_rounds',
          'check_execution_assignments',
          'check_round_outbox'
        )
      order by table_name
    `);

    expect(result.rows.map((row) => row.table_name)).toEqual([
      'check_execution_assignments',
      'check_round_outbox',
      'check_rounds',
      'monitor_configuration_versions',
      'monitors',
    ]);

    const configurations = await connection.db.execute<{
      organization_id: string;
      monitor_id: string;
      version_number: number;
      url: string;
      method: string;
      timeout_ms: number;
      locations: string[];
    }>(sql`
      select
        organization_id,
        monitor_id,
        version_number,
        url,
        method,
        timeout_ms,
        locations
      from monitor_configuration_versions
      where monitor_id = ${existingMonitor.id}
    `);

    expect(configurations.rows).toEqual([
      {
        organization_id: existingMonitor.organizationId,
        monitor_id: existingMonitor.id,
        version_number: 1,
        url: 'https://example.com/health',
        method: 'GET',
        timeout_ms: 10_000,
        locations: ['local'],
      },
    ]);
  });

  async function applyMigration(
    migrations: ReturnType<typeof readMigrationFiles>,
    index: number,
  ): Promise<void> {
    const migration = migrations[index];

    if (!migration) {
      throw new Error(`Migration ${index} was not found.`);
    }

    await connection.db.transaction(async (tx) => {
      for (const statement of migration.sql) {
        if (statement.trim().length > 0) {
          await tx.execute(sql.raw(statement));
        }
      }
    });
  }
});
