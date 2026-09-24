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

const existingRound = {
  id: '22222222-2222-4222-8222-222222222222',
  assignmentId: '44444444-4444-4444-8444-444444444444',
  outboxId: '33333333-3333-4333-8333-333333333333',
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

    const configuration = await connection.db.execute<{ id: string }>(sql`
      select id
      from monitor_configuration_versions
      where monitor_id = ${existingMonitor.id}
    `);

    await connection.db.execute(sql`
      insert into check_rounds (
        id,
        organization_id,
        monitor_id,
        monitor_configuration_version_id
      )
      values (
        ${existingRound.id},
        ${existingMonitor.organizationId},
        ${existingMonitor.id},
        ${configuration.rows[0]!.id}
      )
    `);

    await connection.db.execute(sql`
      insert into check_round_outbox (id, round_id, payload)
      values (
        ${existingRound.outboxId},
        ${existingRound.id},
        ${JSON.stringify({ contractVersion: 1, roundId: existingRound.id })}::jsonb
      )
    `);

    await applyMigration(migrations, 2);

    await connection.db.execute(sql`
      insert into check_execution_assignments (
        id,
        organization_id,
        round_id
      )
      values (
        ${existingRound.assignmentId},
        ${existingMonitor.organizationId},
        ${existingRound.id}
      )
    `);

    await applyMigration(migrations, 3);

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
          'check_execution_results',
          'check_round_outbox'
        )
      order by table_name
    `);

    expect(result.rows.map((row) => row.table_name)).toEqual([
      'check_execution_assignments',
      'check_execution_results',
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

    const outbox = await connection.db.execute<{
      available_at: string;
      claim_token: string | null;
      attempt_count: number;
      last_attempt_at: Date | null;
      last_error_code: string | null;
      blocked_at: Date | null;
      blocked_reason: string | null;
    }>(sql`
      select
        available_at,
        claim_token,
        attempt_count,
        last_attempt_at,
        last_error_code,
        blocked_at,
        blocked_reason
      from check_round_outbox
      where id = ${existingRound.outboxId}
    `);

    expect(outbox.rows).toHaveLength(1);
    expect(Number.isNaN(new Date(outbox.rows[0]!.available_at).getTime())).toBe(false);
    expect(outbox.rows[0]).toMatchObject({
      claim_token: null,
      attempt_count: 0,
      last_attempt_at: null,
      last_error_code: null,
      blocked_at: null,
      blocked_reason: null,
    });

    const indexes = await connection.db.execute<{ indexname: string }>(sql`
      select indexname
      from pg_indexes
      where schemaname = 'public'
        and tablename = 'check_round_outbox'
        and indexname like 'check_round_outbox_%_idx'
      order by indexname
    `);

    expect(indexes.rows).toEqual([{ indexname: 'check_round_outbox_eligible_idx' }]);

    const assignments = await connection.db.execute<{
      status: string;
      claim_token: string | null;
      claim_expires_at: Date | null;
      attempt_count: number;
      completed_at: Date | null;
    }>(sql`
      select
        status,
        claim_token,
        claim_expires_at,
        attempt_count,
        completed_at
      from check_execution_assignments
      where id = ${existingRound.assignmentId}
    `);

    expect(assignments.rows).toEqual([
      {
        status: 'PENDING',
        claim_token: null,
        claim_expires_at: null,
        attempt_count: 0,
        completed_at: null,
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
