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

const existingPausedMonitorId = '55555555-5555-4555-8555-555555555555';
const existingArchivedMonitorId = '66666666-6666-4666-8666-666666666666';
const legacyRemoteLocationId = 'abcdefab-cdef-4abc-8def-abcdefabcdef';
const legacyUppercaseRemoteLocationId = legacyRemoteLocationId.toUpperCase();
const legacyAuthUserId = '77777777-7777-4777-8777-777777777777';
const legacyAuthOrganizationId = '88888888-8888-4888-8888-888888888888';
const legacyAuthApiKeyId = '99999999-9999-4999-8999-999999999999';

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
      insert into monitors (id, organization_id, name, url, lifecycle_state)
      values
        (
          ${existingMonitor.id},
          ${existingMonitor.organizationId},
          'Existing monitor',
          'https://example.com/health',
          'ENABLED'
        ),
        (
          ${existingPausedMonitorId},
          ${existingMonitor.organizationId},
          'Existing paused monitor',
          'https://paused.example.com/health',
          'PAUSED'
        ),
        (
          ${existingArchivedMonitorId},
          ${existingMonitor.organizationId},
          'Existing archived monitor',
          'https://archived.example.com/health',
          'ARCHIVED'
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
    const multiLocationMigrationIndex = migrations.findIndex((migration) =>
      migration.sql.some((statement) => statement.includes('check_round_locations')),
    );
    expect(multiLocationMigrationIndex).toBeGreaterThan(3);
    for (let index = 4; index < multiLocationMigrationIndex; index += 1) {
      await applyMigration(migrations, index);
    }

    await connection.db.execute(sql`
      insert into probe_locations (id, organization_id, name, slug)
      values (
        ${legacyRemoteLocationId},
        ${existingMonitor.organizationId},
        'Legacy remote',
        'legacy-remote'
      )
    `);
    await connection.db.execute(sql`
      update monitors
      set locations = jsonb_build_array(${legacyUppercaseRemoteLocationId}::text)
      where id = ${existingMonitor.id}
    `);
    await connection.db.execute(sql`
      update monitor_configuration_versions
      set locations = jsonb_build_array(${legacyUppercaseRemoteLocationId}::text)
      where monitor_id = ${existingMonitor.id}
    `);
    await connection.db.execute(sql`
      update check_execution_assignments
      set
        location = ${legacyRemoteLocationId},
        probe_location_id = ${legacyRemoteLocationId}
      where id = ${existingRound.assignmentId}
    `);

    const identityRepairMigrationIndex = migrations.findIndex((migration) =>
      migration.sql.some((statement) => statement.includes('Legacy API credentials')),
    );
    expect(identityRepairMigrationIndex).toBeGreaterThan(multiLocationMigrationIndex);
    for (
      let index = multiLocationMigrationIndex;
      index < identityRepairMigrationIndex;
      index += 1
    ) {
      await applyMigration(migrations, index);
    }

    // Recreate the original 0029 identity shape to prove the additive repair
    // migration upgrades databases that applied it before the follow-up edits.
    await connection.db.execute(sql`
      drop index if exists api_key_organization_idx;
      alter table api_key drop constraint if exists api_key_organization_id_organization_id_fk;
      alter table api_key drop column if exists organization_id;

      drop index if exists account_provider_account_unique;
      create index account_provider_idx on account (provider_id, account_id);

      alter table member drop constraint member_role_valid;
      alter table member alter column role set default 'member';
      alter table member add constraint member_role_valid
        check (role in ('owner', 'admin', 'editor', 'viewer', 'member'));
    `);
    await connection.db.execute(sql`
      insert into "user" (id, name, email)
      values (${legacyAuthUserId}, '', 'legacy-auth@example.test');
    `);
    await connection.db.execute(sql`
      insert into organization (id, name, slug)
      values (${legacyAuthOrganizationId}, 'Legacy auth', 'legacy-auth');
    `);
    await connection.db.execute(sql`
      insert into member (organization_id, user_id, role)
      values (${legacyAuthOrganizationId}, ${legacyAuthUserId}, 'member');
    `);
    await connection.db.execute(sql`
      insert into api_key (id, key, user_id)
      values (${legacyAuthApiKeyId}, 'legacy-api-key-hash', ${legacyAuthUserId});
    `);

    for (let index = identityRepairMigrationIndex; index < migrations.length; index += 1) {
      await applyMigration(migrations, index);
    }

    const repairedIdentity = await connection.db.execute<{
      organization_id: string;
      role: string;
    }>(sql`
      select api_key.organization_id, member.role
      from api_key
      inner join member on member.user_id = api_key.user_id
      where api_key.id = ${legacyAuthApiKeyId}
    `);
    expect(repairedIdentity.rows).toEqual([
      { organization_id: legacyAuthOrganizationId, role: 'viewer' },
    ]);

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
          'check_regional_executions',
          'check_regional_evaluations',
          'check_round_aggregates',
          'check_round_outbox'
          ,'check_round_locations'
          ,'incidents'
          ,'monitor_incident_state'
          ,'notification_deliveries'
          ,'notification_events'
          ,'webhook_endpoint_versions'
          ,'webhook_endpoints'
          ,'probe_locations'
          ,'probe_agents'
          ,'probe_agent_enrollments'
          ,'probe_agent_credentials'
          ,'probe_execution_attempts'
        )
      order by table_name
    `);

    expect(result.rows.map((row) => row.table_name)).toEqual([
      'check_execution_assignments',
      'check_execution_results',
      'check_regional_evaluations',
      'check_regional_executions',
      'check_round_aggregates',
      'check_round_locations',
      'check_round_outbox',
      'check_rounds',
      'incidents',
      'monitor_configuration_versions',
      'monitor_incident_state',
      'monitors',
      'notification_deliveries',
      'notification_events',
      'probe_agent_credentials',
      'probe_agent_enrollments',
      'probe_agents',
      'probe_execution_attempts',
      'probe_locations',
      'webhook_endpoint_versions',
      'webhook_endpoints',
    ]);

    const incidentStates = await connection.db.execute<{
      monitor_id: string;
      consecutive_failures: number;
      tracking_started_at: string;
      last_processed_round_id: string | null;
    }>(sql`
      select
        monitor_id,
        consecutive_failures,
        tracking_started_at,
        last_processed_round_id
      from monitor_incident_state
      order by monitor_id
    `);
    expect(incidentStates.rows).toHaveLength(3);
    expect(incidentStates.rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          monitor_id: existingMonitor.id,
          consecutive_failures: 0,
          last_processed_round_id: null,
        }),
      ]),
    );
    for (const state of incidentStates.rows) {
      expect(Number.isNaN(new Date(state.tracking_started_at).getTime())).toBe(false);
    }
    const migratedIncidents = await connection.db.execute(sql`select id from incidents`);
    expect(migratedIncidents.rows).toEqual([]);
    const migratedNotificationEvents = await connection.db.execute(
      sql`select id from notification_events`,
    );
    expect(migratedNotificationEvents.rows).toEqual([]);

    const availability = await connection.pool.query<{
      monitor_id: string;
      current_state: string;
      state_since: Date;
      accounted_through: Date;
      tracking_started_at: Date;
      enabled_since: Date | null;
      last_processed_round_id: string | null;
    }>('select * from monitor_availability_state order by monitor_id');
    expect(availability.rows).toHaveLength(3);
    for (const state of availability.rows) {
      expect(state.current_state).toBe(
        state.monitor_id === existingMonitor.id ? 'UNKNOWN' : 'EXCLUDED',
      );
      expect(state.state_since).toEqual(state.tracking_started_at);
      expect(state.accounted_through).toEqual(state.tracking_started_at);
      expect(state.enabled_since).toEqual(
        state.monitor_id === existingMonitor.id ? state.tracking_started_at : null,
      );
      expect(state.last_processed_round_id).toBeNull();
    }
    expect(new Set(availability.rows.map((s) => s.tracking_started_at.getTime())).size).toBe(1);
    expect((await connection.pool.query('select * from monitor_availability_daily')).rows).toEqual(
      [],
    );

    const configurations = await connection.db.execute<{
      organization_id: string;
      monitor_id: string;
      version_number: number;
      url: string;
      method: string;
      timeout_ms: number;
      interval_seconds: number;
      locations: string[];
    }>(sql`
      select
        organization_id,
        monitor_id,
        version_number,
        url,
        method,
        timeout_ms,
        interval_seconds,
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
        interval_seconds: 60,
        locations: [legacyRemoteLocationId],
      },
    ]);

    const migratedAssignment = await connection.pool.query<{
      location: string;
      probe_location_id: string | null;
      execution_policy_version: string;
      required_engine_version: string;
      pending_since: Date;
      created_at: Date;
    }>(
      `select location, probe_location_id, execution_policy_version, required_engine_version,
              pending_since, created_at
         from check_execution_assignments
        where id = $1`,
      [existingRound.assignmentId],
    );
    expect(migratedAssignment.rows).toHaveLength(1);
    expect(migratedAssignment.rows[0]).toMatchObject({
      location: legacyRemoteLocationId,
      probe_location_id: legacyRemoteLocationId,
      execution_policy_version: 'http-v1',
      required_engine_version: 'watchrail-http-v1',
    });
    expect(migratedAssignment.rows[0]!.pending_since).toEqual(
      migratedAssignment.rows[0]!.created_at,
    );

    const migratedRound = await connection.pool.query<{
      contract_version: number;
      aggregation_policy_version: number;
      confirmation_policy_version: number;
      created_at: Date;
      finalization_deadline_at: Date;
    }>(
      `select contract_version, aggregation_policy_version, confirmation_policy_version,
              created_at, finalization_deadline_at
         from check_rounds
        where id = $1`,
      [existingRound.id],
    );
    expect(migratedRound.rows[0]).toMatchObject({
      contract_version: 1,
      aggregation_policy_version: 1,
      confirmation_policy_version: 1,
    });
    expect(
      migratedRound.rows[0]!.finalization_deadline_at.getTime() -
        migratedRound.rows[0]!.created_at.getTime(),
    ).toBe(120_000);
    expect(
      await connection.pool.query(
        `select organization_id, round_id, location, probe_location_id, position
           from check_round_locations
          where round_id = $1`,
        [existingRound.id],
      ),
    ).toMatchObject({
      rows: [
        {
          organization_id: existingMonitor.organizationId,
          round_id: existingRound.id,
          location: legacyRemoteLocationId,
          probe_location_id: legacyRemoteLocationId,
          position: 0,
        },
      ],
    });

    const scheduling = await connection.db.execute<{
      lifecycle_state: string;
      interval_seconds: number;
      next_check_at: string | null;
    }>(sql`
      select lifecycle_state, interval_seconds, next_check_at
      from monitors
      where id in (
        ${existingMonitor.id},
        ${existingPausedMonitorId},
        ${existingArchivedMonitorId}
      )
      order by id
    `);

    expect(scheduling.rows).toHaveLength(3);
    expect(scheduling.rows[0]).toMatchObject({
      lifecycle_state: 'ENABLED',
      interval_seconds: 60,
    });
    expect(Number.isNaN(new Date(scheduling.rows[0]!.next_check_at!).getTime())).toBe(false);
    expect(scheduling.rows.slice(1)).toEqual([
      { lifecycle_state: 'PAUSED', interval_seconds: 60, next_check_at: null },
      { lifecycle_state: 'ARCHIVED', interval_seconds: 60, next_check_at: null },
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
