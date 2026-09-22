import { resolve } from 'node:path';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { and, desc, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { createMonitor } from '@watchrail/domain';
import { createDatabaseConnection, type DatabaseConnection } from './client.js';
import { ManualRoundRepository, MonitorNotFoundError } from './manual-round-repository.js';
import { migrateDatabase } from './migration.js';
import { MonitorRepository } from './monitor-repository.js';
import {
  checkExecutionAssignments,
  checkRoundOutbox,
  checkRounds,
  monitorConfigurationVersions,
  monitors,
} from './schema.js';

const organizationA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const organizationB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

describe('ManualRoundRepository', () => {
  let container: StartedPostgreSqlContainer;
  let connection: DatabaseConnection;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:18.0-alpine').start();

    connection = createDatabaseConnection(container.getConnectionUri());

    await migrateDatabase(connection, resolve(process.cwd(), 'drizzle'));
  }, 60_000);

  beforeEach(async () => {
    await connection.pool.query(`
      truncate table
        check_round_outbox,
        check_execution_assignments,
        check_rounds,
        monitor_configuration_versions,
        monitors
      cascade
    `);
  });

  afterAll(async () => {
    await connection?.pool.end();
    await container?.stop();
  });

  async function createMonitorForOrganization(organizationId: string) {
    const repository = new MonitorRepository(connection.db);

    return repository.create(
      organizationId,
      createMonitor({
        name: 'Public API',
        url: 'https://example.com/health',
      }),
    );
  }

  it('commits round, local assignment and outbox together', async () => {
    const monitor = await createMonitorForOrganization(organizationA);

    const repository = new ManualRoundRepository(connection.db);

    const round = await repository.create(organizationA, monitor.id);

    expect(round).toMatchObject({
      organizationId: organizationA,
      monitorId: monitor.id,
      trigger: 'MANUAL',
      status: 'PENDING',
    });

    const configurations = await connection.db
      .select()
      .from(monitorConfigurationVersions)
      .where(eq(monitorConfigurationVersions.monitorId, monitor.id));

    expect(configurations).toHaveLength(1);

    expect(round.monitorConfigurationVersionId).toBe(configurations[0]!.id);

    const assignments = await connection.db
      .select()
      .from(checkExecutionAssignments)
      .where(eq(checkExecutionAssignments.roundId, round.id));

    expect(assignments).toHaveLength(1);

    expect(assignments[0]).toMatchObject({
      organizationId: organizationA,
      roundId: round.id,
      location: 'local',
      status: 'PENDING',
    });

    const outbox = await connection.db
      .select()
      .from(checkRoundOutbox)
      .where(eq(checkRoundOutbox.roundId, round.id));

    expect(outbox).toHaveLength(1);

    expect(outbox[0]!.payload).toEqual({
      contractVersion: 1,
      roundId: round.id,
    });

    expect(outbox[0]!.publishedAt).toBeNull();
  });

  it('rolls back round state when outbox creation fails', async () => {
    const monitor = await createMonitorForOrganization(organizationA);

    await connection.db.execute(sql`
      create or replace function
        watchrail_test_fail_outbox_insert()
      returns trigger
      language plpgsql
      as $$
      begin
        raise exception 'forced outbox failure';
      end;
      $$;
    `);

    await connection.db.execute(sql`
      create trigger
        watchrail_test_fail_outbox_insert
      before insert on check_round_outbox
      for each row
      execute function
        watchrail_test_fail_outbox_insert();
    `);

    try {
      const repository = new ManualRoundRepository(connection.db);

      await expect(repository.create(organizationA, monitor.id)).rejects.toMatchObject({
        cause: expect.objectContaining({
          message: expect.stringContaining('forced outbox failure'),
        }),
      });

      const [roundCount] = await connection.db
        .select({
          count: sql<number>`count(*)::int`,
        })
        .from(checkRounds);

      const [assignmentCount] = await connection.db
        .select({
          count: sql<number>`count(*)::int`,
        })
        .from(checkExecutionAssignments);

      const [outboxCount] = await connection.db
        .select({
          count: sql<number>`count(*)::int`,
        })
        .from(checkRoundOutbox);

      expect(roundCount!.count).toBe(0);
      expect(assignmentCount!.count).toBe(0);
      expect(outboxCount!.count).toBe(0);
    } finally {
      await connection.db.execute(sql`
        drop trigger if exists
          watchrail_test_fail_outbox_insert
        on check_round_outbox
      `);

      await connection.db.execute(sql`
        drop function if exists
          watchrail_test_fail_outbox_insert()
      `);
    }
  });

  it('does not expose a monitor across organizations', async () => {
    const monitor = await createMonitorForOrganization(organizationA);

    const repository = new ManualRoundRepository(connection.db);

    await expect(repository.create(organizationB, monitor.id)).rejects.toBeInstanceOf(
      MonitorNotFoundError,
    );

    const rounds = await connection.db.select().from(checkRounds);

    expect(rounds).toEqual([]);
  });

  it.each(['PAUSED', 'ARCHIVED'] as const)(
    'does not create a round for a %s monitor',
    async (lifecycleState) => {
      const monitor = await createMonitorForOrganization(organizationA);

      await connection.db
        .update(monitors)
        .set({
          lifecycleState,
          updatedAt: new Date(),
        })
        .where(eq(monitors.id, monitor.id));

      const repository = new ManualRoundRepository(connection.db);

      await expect(repository.create(organizationA, monitor.id)).rejects.toMatchObject({
        name: 'MonitorNotRunnableError',
        lifecycleState,
      });

      const rounds = await connection.db.select().from(checkRounds);

      expect(rounds).toEqual([]);
    },
  );

  it('retains the captured configuration when the monitor later changes', async () => {
    const monitor = await createMonitorForOrganization(organizationA);

    const repository = new ManualRoundRepository(connection.db);

    const round = await repository.create(organizationA, monitor.id);

    const [capturedBeforeChange] = await connection.db
      .select()
      .from(monitorConfigurationVersions)
      .where(eq(monitorConfigurationVersions.id, round.monitorConfigurationVersionId));

    expect(capturedBeforeChange).toMatchObject({
      versionNumber: 1,
      url: 'https://example.com/health',
      method: 'GET',
      timeoutMs: 10_000,
      locations: ['local'],
    });

    /*
     * Simulate the future monitor-update transaction.
     *
     * Configuration changes append a version. They do not mutate
     * version 1.
     */
    await connection.db.transaction(async (tx) => {
      await tx
        .select({
          id: monitors.id,
        })
        .from(monitors)
        .where(and(eq(monitors.id, monitor.id), eq(monitors.organizationId, organizationA)))
        .for('update');

      const [latest] = await tx
        .select({
          versionNumber: monitorConfigurationVersions.versionNumber,
        })
        .from(monitorConfigurationVersions)
        .where(eq(monitorConfigurationVersions.monitorId, monitor.id))
        .orderBy(desc(monitorConfigurationVersions.versionNumber))
        .limit(1);

      await tx.insert(monitorConfigurationVersions).values({
        organizationId: organizationA,

        monitorId: monitor.id,

        versionNumber: latest!.versionNumber + 1,

        url: 'https://new.example.com/health',

        method: 'GET',

        timeoutMs: 5_000,

        locations: ['local'],
      });

      await tx
        .update(monitors)
        .set({
          url: 'https://new.example.com/health',

          timeoutMs: 5_000,

          updatedAt: new Date(),
        })
        .where(eq(monitors.id, monitor.id));
    });

    const [capturedAfterChange] = await connection.db
      .select()
      .from(monitorConfigurationVersions)
      .where(eq(monitorConfigurationVersions.id, round.monitorConfigurationVersionId));

    expect(capturedAfterChange).toMatchObject({
      versionNumber: 1,
      url: 'https://example.com/health',
      timeoutMs: 10_000,
    });

    const versions = await connection.db
      .select()
      .from(monitorConfigurationVersions)
      .where(eq(monitorConfigurationVersions.monitorId, monitor.id))
      .orderBy(monitorConfigurationVersions.versionNumber);

    expect(versions).toHaveLength(2);

    expect(versions[1]).toMatchObject({
      versionNumber: 2,
      url: 'https://new.example.com/health',
      timeoutMs: 5_000,
    });
  });

  it('creates exactly one outbox event for a manual round', async () => {
    const monitor = await createMonitorForOrganization(organizationA);

    const repository = new ManualRoundRepository(connection.db);

    const round = await repository.create(organizationA, monitor.id);

    const events = await connection.db
      .select()
      .from(checkRoundOutbox)
      .where(eq(checkRoundOutbox.roundId, round.id));

    expect(events).toHaveLength(1);

    expect(events[0]!.payload).toEqual({
      contractVersion: 1,
      roundId: round.id,
    });
  });
});
