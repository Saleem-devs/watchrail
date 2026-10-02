import { resolve } from 'node:path';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { createMonitor } from '@watchrail/domain';
import { createDatabaseConnection, type DatabaseConnection } from './client.js';
import { ManualRoundRepository } from './manual-round-repository.js';
import { migrateDatabase } from './migration.js';
import { MonitorRepository } from './monitor-repository.js';
import { ScheduledRoundRepository } from './scheduled-round-repository.js';
import {
  checkExecutionAssignments,
  checkRoundOutbox,
  checkRounds,
  monitorConfigurationVersions,
  monitors,
} from './schema.js';

const organizationId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

describe('ScheduledRoundRepository', () => {
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
        check_execution_results,
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

  it('atomically creates scheduled work and advances from the current database time', async () => {
    const monitor = await createDueMonitor('Due monitor', 300);
    const originalUpdatedAt = monitor.updatedAt;
    const beforeDispatch = Date.now();

    const rounds = await new ScheduledRoundRepository(connection.db).dispatchDue(100);

    expect(rounds).toHaveLength(1);
    expect(rounds[0]).toMatchObject({
      organizationId,
      monitorId: monitor.id,
      trigger: 'SCHEDULED',
      status: 'PENDING',
    });

    const [configuration] = await connection.db
      .select()
      .from(monitorConfigurationVersions)
      .where(eq(monitorConfigurationVersions.monitorId, monitor.id));
    expect(rounds[0]!.monitorConfigurationVersionId).toBe(configuration?.id);

    const assignments = await connection.db.select().from(checkExecutionAssignments);
    expect(assignments).toHaveLength(1);
    expect(assignments[0]).toMatchObject({
      roundId: rounds[0]!.id,
      location: 'local',
      status: 'PENDING',
    });

    const events = await connection.db.select().from(checkRoundOutbox);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      roundId: rounds[0]!.id,
      payload: { contractVersion: 1, roundId: rounds[0]!.id },
    });

    const [projection] = await connection.db
      .select()
      .from(monitors)
      .where(eq(monitors.id, monitor.id));
    expect(projection!.nextCheckAt!.getTime()).toBeGreaterThanOrEqual(beforeDispatch + 299_000);
    expect(projection!.updatedAt).toEqual(originalUpdatedAt);

    await expect(new ScheduledRoundRepository(connection.db).dispatchDue(100)).resolves.toEqual([]);
    expect(await connection.db.select().from(checkRounds)).toHaveLength(1);
  });

  it('ignores non-due, paused, and archived monitors', async () => {
    const future = await createMonitorRecord('Future');
    const paused = await createMonitorRecord('Paused');
    const archived = await createMonitorRecord('Archived');
    const monitorRepository = new MonitorRepository(connection.db);
    await monitorRepository.updateLifecycle(organizationId, paused.id, 'PAUSED');
    await monitorRepository.updateLifecycle(organizationId, archived.id, 'ARCHIVED');

    const rounds = await new ScheduledRoundRepository(connection.db).dispatchDue(100);

    expect(rounds).toEqual([]);
    expect(await connection.db.select().from(checkRounds)).toEqual([]);
    const projections = await connection.db.select().from(monitors).orderBy(asc(monitors.id));
    expect(projections.find((value) => value.id === future.id)?.nextCheckAt).not.toBeNull();
    expect(projections.find((value) => value.id === paused.id)?.nextCheckAt).toBeNull();
    expect(projections.find((value) => value.id === archived.id)?.nextCheckAt).toBeNull();
  });

  it('dispatches a deterministic bounded batch ordered by deadline then id', async () => {
    const first = await createDueMonitor('First', 60, new Date('2026-01-01T00:00:00Z'));
    const second = await createDueMonitor('Second', 60, new Date('2026-01-01T00:00:01Z'));
    await createDueMonitor('Third', 60, new Date('2026-01-01T00:00:02Z'));

    const rounds = await new ScheduledRoundRepository(connection.db).dispatchDue(2);

    expect(rounds.map((round) => round.monitorId)).toEqual([first.id, second.id]);
    expect(await connection.db.select().from(checkRounds)).toHaveLength(2);
  });

  it('prevents duplicate scheduled rounds across concurrent dispatchers', async () => {
    const monitor = await createDueMonitor('Concurrent');
    const first = createNamedConnection('scheduler-one');
    const second = createNamedConnection('scheduler-two');
    try {
      const results = await Promise.all([
        new ScheduledRoundRepository(first.db).dispatchDue(1),
        new ScheduledRoundRepository(second.db).dispatchDue(1),
      ]);
      expect(results.flat().map((round) => round.monitorId)).toEqual([monitor.id]);
    } finally {
      await Promise.all([first.pool.end(), second.pool.end()]);
    }
    expect(await connection.db.select().from(checkRounds)).toHaveLength(1);
  });

  it('allows concurrent dispatchers to divide distinct due monitors', async () => {
    const firstMonitor = await createDueMonitor('One');
    const secondMonitor = await createDueMonitor('Two');
    const first = createNamedConnection('scheduler-a');
    const second = createNamedConnection('scheduler-b');
    try {
      const results = await Promise.all([
        new ScheduledRoundRepository(first.db).dispatchDue(1),
        new ScheduledRoundRepository(second.db).dispatchDue(1),
      ]);
      expect(new Set(results.flat().map((round) => round.monitorId))).toEqual(
        new Set([firstMonitor.id, secondMonitor.id]),
      );
    } finally {
      await Promise.all([first.pool.end(), second.pool.end()]);
    }
  });

  it('rolls back the round, assignment, deadline, and outbox when publication staging fails', async () => {
    const monitor = await createDueMonitor('Rollback');
    const originalDeadline = monitor.nextCheckAt;
    await connection.pool.query(`
      create function watchrail_test_fail_outbox() returns trigger language plpgsql as $$
      begin
        raise exception 'forced outbox failure';
      end;
      $$;
      create trigger watchrail_test_fail_outbox
      before insert on check_round_outbox
      for each row execute function watchrail_test_fail_outbox();
    `);

    try {
      await expect(new ScheduledRoundRepository(connection.db).dispatchDue(1)).rejects.toThrow();
    } finally {
      await connection.pool.query(`
        drop trigger watchrail_test_fail_outbox on check_round_outbox;
        drop function watchrail_test_fail_outbox();
      `);
    }

    expect(await connection.db.select().from(checkRounds)).toEqual([]);
    expect(await connection.db.select().from(checkExecutionAssignments)).toEqual([]);
    expect(await connection.db.select().from(checkRoundOutbox)).toEqual([]);
    const [projection] = await connection.db
      .select()
      .from(monitors)
      .where(eq(monitors.id, monitor.id));
    expect(projection?.nextCheckAt).toEqual(originalDeadline);
  });

  it('keeps manual work independent from the scheduled deadline', async () => {
    const monitor = await createDueMonitor('Manual and scheduled');
    const manual = await new ManualRoundRepository(connection.db).create(
      organizationId,
      monitor.id,
    );
    const [scheduled] = await new ScheduledRoundRepository(connection.db).dispatchDue(1);

    expect(manual.trigger).toBe('MANUAL');
    expect(scheduled?.trigger).toBe('SCHEDULED');
    const rounds = await connection.db
      .select()
      .from(checkRounds)
      .orderBy(asc(checkRounds.createdAt));
    expect(rounds.map((round) => round.trigger).sort()).toEqual(['MANUAL', 'SCHEDULED']);
  });

  it('honors lifecycle lock order around a due dispatch', async () => {
    const pausedFirst = await createDueMonitor('Pause first');
    const repository = new MonitorRepository(connection.db);
    await repository.updateLifecycle(organizationId, pausedFirst.id, 'PAUSED');
    await expect(new ScheduledRoundRepository(connection.db).dispatchDue(1)).resolves.toEqual([]);

    const dispatchedFirst = await createDueMonitor('Dispatch first');
    const [round] = await new ScheduledRoundRepository(connection.db).dispatchDue(1);
    const paused = await repository.updateLifecycle(organizationId, dispatchedFirst.id, 'PAUSED');
    expect(round?.monitorId).toBe(dispatchedFirst.id);
    expect(paused).toMatchObject({ lifecycleState: 'PAUSED', nextCheckAt: null });
  });

  it('captures the immutable configuration determined by lock order', async () => {
    const updateFirst = await createDueMonitor('Update first');
    const repository = new MonitorRepository(connection.db);
    await repository.updateHttpSettings(organizationId, updateFirst.id, {
      url: 'https://new.example.com',
      method: 'HEAD',
      timeoutMs: 5_000,
      followRedirects: false,
    });
    const [newConfigurationRound] = await new ScheduledRoundRepository(connection.db).dispatchDue(
      1,
    );
    const [newConfiguration] = await connection.db
      .select()
      .from(monitorConfigurationVersions)
      .where(
        eq(monitorConfigurationVersions.id, newConfigurationRound!.monitorConfigurationVersionId),
      );
    expect(newConfiguration).toMatchObject({ versionNumber: 2, url: 'https://new.example.com' });

    const dispatchFirst = await createDueMonitor('Dispatch first');
    const [oldConfigurationRound] = await new ScheduledRoundRepository(connection.db).dispatchDue(
      1,
    );
    await repository.updateHttpSettings(organizationId, dispatchFirst.id, {
      url: 'https://later.example.com',
      method: 'GET',
      timeoutMs: 6_000,
      followRedirects: true,
    });
    const [oldConfiguration] = await connection.db
      .select()
      .from(monitorConfigurationVersions)
      .where(
        eq(monitorConfigurationVersions.id, oldConfigurationRound!.monitorConfigurationVersionId),
      );
    expect(oldConfiguration).toMatchObject({ versionNumber: 1, url: 'https://example.com/health' });
  });

  it('honors schedule-setting lock order around an obsolete due slot', async () => {
    const updateFirst = await createDueMonitor('Interval first');
    const repository = new MonitorRepository(connection.db);
    await repository.updateScheduleSettings(organizationId, updateFirst.id, 300);
    await expect(new ScheduledRoundRepository(connection.db).dispatchDue(1)).resolves.toEqual([]);

    const dispatchFirst = await createDueMonitor('Due first');
    const [round] = await new ScheduledRoundRepository(connection.db).dispatchDue(1);
    const updated = await repository.updateScheduleSettings(organizationId, dispatchFirst.id, 300);
    expect(round?.monitorId).toBe(dispatchFirst.id);
    expect(updated.intervalSeconds).toBe(300);
    expect(updated.nextCheckAt!.getTime()).toBeGreaterThan(Date.now() + 299_000);
  });

  it.each([0, 1.5, 1_001])('rejects invalid batch size %s', async (batchSize) => {
    await expect(
      new ScheduledRoundRepository(connection.db).dispatchDue(batchSize),
    ).rejects.toThrow(RangeError);
  });

  async function createMonitorRecord(name: string, intervalSeconds = 60) {
    return new MonitorRepository(connection.db).create(
      organizationId,
      createMonitor({ name, url: 'https://example.com/health', intervalSeconds }),
    );
  }

  async function createDueMonitor(
    name: string,
    intervalSeconds = 60,
    deadline = new Date('2020-01-01T00:00:00Z'),
  ) {
    const monitor = await createMonitorRecord(name, intervalSeconds);
    const [due] = await connection.db
      .update(monitors)
      .set({ nextCheckAt: deadline })
      .where(eq(monitors.id, monitor.id))
      .returning();
    return due!;
  }

  function createNamedConnection(applicationName: string): DatabaseConnection {
    const uri = new URL(container.getConnectionUri());
    uri.searchParams.set('application_name', applicationName);
    return createDatabaseConnection(uri.toString());
  }
});
