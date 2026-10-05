import { resolve } from 'node:path';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createMonitor,
  EMPTY_ASSERTION_EVALUATION,
  type AvailabilityWindowState,
} from '@watchrail/domain';
import { AvailabilityRepository, accrueAvailability } from './availability-repository.js';
import {
  CheckExecutionRepository,
  type AuthoritativeCheckResult,
} from './check-execution-repository.js';
import { createDatabaseConnection, type DatabaseConnection } from './client.js';
import { ManualRoundRepository } from './manual-round-repository.js';
import { migrateDatabase } from './migration.js';
import { MonitorRepository } from './monitor-repository.js';
import { ScheduledRoundRepository } from './scheduled-round-repository.js';
import {
  checkExecutionAssignments,
  checkExecutionResults,
  checkRounds,
  monitorAvailabilityDaily,
  monitorAvailabilityState,
  monitorIncidentState,
  monitors,
} from './schema.js';

const organizationId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const dayMs = 86_400_000;

describe('daily availability accounting', () => {
  let container: StartedPostgreSqlContainer;
  let connection: DatabaseConnection;
  let monitorId: string;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:18.0-alpine').start();
    connection = createDatabaseConnection(container.getConnectionUri());
    await migrateDatabase(connection, resolve(process.cwd(), 'drizzle'));
  }, 60_000);

  beforeEach(async () => {
    await connection.pool.query('truncate monitors cascade');
    monitorId = (
      await new MonitorRepository(connection.db).create(
        organizationId,
        createMonitor({ name: 'Availability', url: 'https://example.com' }),
      )
    ).id;
  });

  afterAll(async () => {
    await connection?.pool.end();
    await container?.stop();
  });

  it('starts UNKNOWN without inventing historical durations', async () => {
    const initial = await state();
    expect(initial.currentState).toBe('UNKNOWN');
    expect(initial.stateSince).toEqual(initial.trackingStartedAt);
    expect(initial.accountedThrough).toEqual(initial.trackingStartedAt);
    expect(initial.enabledSince).toEqual(initial.trackingStartedAt);
    expect(initial.lastProcessedRoundId).toBeNull();
    expect(await daily()).toEqual([]);
  });

  it.each(['AVAILABLE', 'UNAVAILABLE', 'UNKNOWN', 'EXCLUDED'] as const)(
    'splits %s across UTC midnight exactly once, independent of session timezone',
    async (currentState) => {
      const start = new Date('2026-01-01T23:59:30.000Z');
      const end = new Date('2026-01-02T00:01:10.000Z');
      await seed(start, currentState);
      await connection.db.transaction(async (tx) => {
        await tx.execute(sql`set local time zone 'Pacific/Auckland'`);
        const [locked] = await tx
          .select()
          .from(monitorAvailabilityState)
          .where(eq(monitorAvailabilityState.monitorId, monitorId))
          .for('update');
        await accrueAvailability(tx, locked!, end);
      });
      const rows = await daily();
      expect(rows.map((row) => row.dayUtc)).toEqual(['2026-01-01', '2026-01-02']);
      const field = {
        AVAILABLE: 'availableMs',
        UNAVAILABLE: 'unavailableMs',
        UNKNOWN: 'unknownMs',
        EXCLUDED: 'excludedMs',
      } as const;
      expect(rows.map((row) => row[field[currentState]])).toEqual([30_000, 70_000]);
      expect(rows.map(total)).toEqual([30_000, 70_000]);
      await connection.db.transaction(async (tx) => accrueAvailability(tx, await state(), end));
      expect(await daily()).toEqual(rows);
      expect((await state()).accountedThrough).toEqual(end);
    },
  );

  it('handles long restart gaps, full UTC days, and an exact midnight endpoint', async () => {
    const start = new Date('2026-01-01T23:59:30Z');
    const end = new Date('2026-01-04T00:00:00Z');
    await seed(start, 'AVAILABLE');
    await connection.db.transaction(async (tx) => accrueAvailability(tx, await state(), end));
    expect((await daily()).map((row) => [row.dayUtc, total(row)])).toEqual([
      ['2026-01-01', 30_000],
      ['2026-01-02', dayMs],
      ['2026-01-03', dayMs],
    ]);
  });

  it('accepts scheduled observations at DB time, not result.checkedAt, and ignores duplicate delivery', async () => {
    const round = await scheduled();
    const initial = await state();
    const claim = await claimed(round.id);
    const executions = new CheckExecutionRepository(connection.db);
    expect(await executions.complete(claim.assignmentId, claim.claimToken, result())).toBe(true);
    const accepted = await state();
    expect(accepted.currentState).toBe('AVAILABLE');
    expect(accepted.stateSince.getTime()).toBeGreaterThanOrEqual(
      initial.accountedThrough.getTime(),
    );
    expect(accepted.stateSince.getFullYear()).not.toBe(2000);
    expect(accepted.accountedThrough).toEqual(accepted.stateSince);
    expect(accepted.lastProcessedRoundId).toBe(round.id);
    expect((await daily()).reduce((sum, row) => sum + row.unknownMs, 0)).toBe(
      accepted.accountedThrough.getTime() - initial.accountedThrough.getTime(),
    );
    const recorded = await daily();
    expect(await executions.complete(claim.assignmentId, claim.claimToken, result())).toBe(false);
    expect(await state()).toEqual(accepted);
    expect(await daily()).toEqual(recorded);
  });

  it.each([
    ['FAIL', 'HTTP', 'UNEXPECTED_STATUS', 'UNAVAILABLE'],
    ['UNKNOWN', 'PROBE', 'INTERNAL_ERROR', 'UNKNOWN'],
    ['UNKNOWN', 'DNS', 'PROHIBITED_DESTINATION', 'UNKNOWN'],
  ] as const)('maps scheduled %s/%s/%s to %s', async (outcome, stage, reason, expected) => {
    await complete((await scheduled()).id, result({ outcome, stage, reason }));
    expect((await state()).currentState).toBe(expected);
  });

  it('uses assertion health independently of the HTTP outcome', async () => {
    await complete(
      (await scheduled()).id,
      result({
        assertionEvaluation: {
          contractVersion: 1,
          outcome: 'FAIL',
          diagnostics: [
            {
              index: 0,
              source: 'TEXT_BODY',
              subject: null,
              operator: 'equals',
              outcome: 'FAIL',
              reason: 'TEXT_BODY_MISMATCH',
            },
          ],
        },
      }),
    );
    expect((await state()).currentState).toBe('UNAVAILABLE');
  });

  it('maps unavailable assertion evidence to UNKNOWN and accrues repeated states without resetting stateSince', async () => {
    await complete((await scheduled()).id, result());
    const available = await state();
    const next = await scheduled();
    await connection.db
      .update(checkRounds)
      .set({ createdAt: new Date(available.lastProcessedRoundCreatedAt!.getTime() + 1) })
      .where(eq(checkRounds.id, next.id));
    await complete(next.id, result());
    expect((await state()).stateSince).toEqual(available.stateSince);
    await complete(
      (await scheduled()).id,
      result({
        assertionEvaluation: {
          contractVersion: 1,
          outcome: 'NOT_EVALUATED',
          diagnostics: [
            {
              index: 0,
              source: 'TEXT_BODY',
              subject: null,
              operator: 'equals',
              outcome: 'NOT_EVALUATED',
              reason: 'BODY_READ_FAILED',
            },
          ],
        },
      }),
    );
    expect((await state()).currentState).toBe('UNKNOWN');
  });

  it.each(['completion', 'pause'] as const)(
    'serializes %s winning the accumulator lock before its competing writer',
    async (firstWriter) => {
      const round = await scheduled();
      const claim = await claimed(round.id);
      await seed(new Date('2026-01-01T00:00:00Z'), 'UNKNOWN');
      const initial = await state();
      const completionConnection = named('availability-completion');
      const lifecycleConnection = named('availability-lifecycle');
      const lock = await connection.pool.connect();
      let completion: Promise<boolean> | undefined;
      let lifecycle: ReturnType<MonitorRepository['updateLifecycle']> | undefined;
      try {
        await lock.query('begin');
        await lock.query(
          'select monitor_id from monitor_availability_state where monitor_id=$1 for update',
          [monitorId],
        );
        const startCompletion = () => {
          completion = new CheckExecutionRepository(completionConnection.db).complete(
            claim.assignmentId,
            claim.claimToken,
            result(),
          );
        };
        const startPause = () => {
          lifecycle = new MonitorRepository(lifecycleConnection.db).updateLifecycle(
            organizationId,
            monitorId,
            'PAUSED',
          );
        };
        if (firstWriter === 'completion') {
          startCompletion();
          await waitForLock('availability-completion');
          startPause();
          await waitForLock('availability-lifecycle');
        } else {
          startPause();
          await waitForLock('availability-lifecycle');
          startCompletion();
          await waitForLock('availability-completion');
        }
        // Flushing does not block either writer or double-claim its interval.
        expect(await new AvailabilityRepository(connection.db).flushDue(1, 1)).toBe(0);
        const releaseAt = (
          await lock.query<{ at: Date }>(
            "select date_trunc('milliseconds', clock_timestamp()) as at",
          )
        ).rows[0]!.at;
        await lock.query('commit');
        expect(await completion).toBe(true);
        await lifecycle;
        const paused = await state();
        expect(paused.currentState).toBe('EXCLUDED');
        expect(paused.accountedThrough.getTime()).toBeGreaterThanOrEqual(releaseAt.getTime());
        expect(paused.lastProcessedRoundId).toBe(firstWriter === 'completion' ? round.id : null);
        expect((await daily()).reduce((sum, row) => sum + total(row), 0)).toBe(
          paused.accountedThrough.getTime() - initial.accountedThrough.getTime(),
        );
      } finally {
        await lock.query('rollback');
        lock.release();
        await Promise.allSettled([completion, lifecycle]);
        await Promise.all([completionConnection.pool.end(), lifecycleConnection.pool.end()]);
      }
    },
  );

  it('flush then completion accrues only the remaining tail, and archiving closes it once', async () => {
    const round = await scheduled();
    const start = new Date('2026-01-01T00:00:00Z');
    await seed(start, 'UNKNOWN');
    await new AvailabilityRepository(connection.db).flushDue(1, 60_000);
    await complete(round.id, result());
    await new MonitorRepository(connection.db).updateLifecycle(
      organizationId,
      monitorId,
      'ARCHIVED',
    );
    const archived = await state();
    expect(archived.currentState).toBe('EXCLUDED');
    expect((await daily()).reduce((sum, row) => sum + total(row), 0)).toBe(
      archived.accountedThrough.getTime() - start.getTime(),
    );
    const rows = await daily();
    await new MonitorRepository(connection.db).updateLifecycle(
      organizationId,
      monitorId,
      'ARCHIVED',
    );
    expect(await new AvailabilityRepository(connection.db).flushDue(1, 1)).toBe(0);
    expect(await state()).toEqual(archived);
    expect(await daily()).toEqual(rows);
  });

  it('does not let manual, stale, pre-tracking, or previous-epoch rounds mutate accounting', async () => {
    const manual = await new ManualRoundRepository(connection.db).create(organizationId, monitorId);
    const initial = await state();
    await complete(manual.id, result());
    expect(await state()).toEqual(initial);
    const old = await scheduled();
    const latest = await scheduled();
    // Explicit logical ordering avoids relying on millisecond creation/UUID ordering.
    await connection.db
      .update(checkRounds)
      .set({ createdAt: new Date(initial.trackingStartedAt.getTime() - 1) })
      .where(eq(checkRounds.id, old.id));
    await complete(latest.id, result());
    const accepted = await state();
    await complete(old.id, result({ outcome: 'FAIL', reason: 'UNEXPECTED_STATUS' }));
    expect(await state()).toEqual(accepted);

    const pending = await scheduled();
    const repository = new MonitorRepository(connection.db);
    await repository.updateLifecycle(organizationId, monitorId, 'PAUSED');
    const paused = await state();
    expect(paused.currentState).toBe('EXCLUDED');
    expect(paused.enabledSince).toBeNull();
    await repository.updateLifecycle(organizationId, monitorId, 'PAUSED');
    expect(await state()).toEqual(paused);
    await repository.updateLifecycle(organizationId, monitorId, 'ENABLED');
    const resumed = await state();
    expect(resumed.currentState).toBe('UNKNOWN');
    expect(resumed.enabledSince).toEqual(resumed.stateSince);
    await connection.db
      .update(checkRounds)
      .set({ createdAt: new Date(resumed.enabledSince!.getTime() - 1) })
      .where(eq(checkRounds.id, pending.id));
    await complete(pending.id, result());
    expect(await state()).toEqual(resumed);
  });

  it('rejects a stale round inside the current epoch, using the round ID tie-break', async () => {
    const older = await scheduled();
    const newer = await scheduled();
    const ordered = [older, newer].sort((a, b) => a.id.localeCompare(b.id));
    const createdAt = new Date((await state()).trackingStartedAt.getTime() + 1);
    for (const round of ordered)
      await connection.db
        .update(checkRounds)
        .set({ createdAt })
        .where(eq(checkRounds.id, round.id));
    await complete(ordered[1]!.id, result());
    const accepted = await state();
    await complete(ordered[0]!.id, result({ outcome: 'FAIL', reason: 'UNEXPECTED_STATUS' }));
    expect(await state()).toEqual(accepted);
  });

  it('flushes enabled and paused monitors but never archived monitors, with a bounded shared cutoff', async () => {
    const paused = (
      await new MonitorRepository(connection.db).create(
        organizationId,
        createMonitor({ name: 'Paused', url: 'https://example.com' }),
      )
    ).id;
    const archived = (
      await new MonitorRepository(connection.db).create(
        organizationId,
        createMonitor({ name: 'Archived', url: 'https://example.com' }),
      )
    ).id;
    await new MonitorRepository(connection.db).updateLifecycle(organizationId, paused, 'PAUSED');
    await new MonitorRepository(connection.db).updateLifecycle(
      organizationId,
      archived,
      'ARCHIVED',
    );
    const start = new Date('2026-01-01T00:00:00Z');
    await seed(start, 'UNKNOWN');
    await seed(start, 'EXCLUDED', paused);
    await seed(start, 'EXCLUDED', archived);
    const repository = new AvailabilityRepository(connection.db);
    expect(await repository.flushDue(2, 60_000)).toBe(2);
    const states = await connection.db.select().from(monitorAvailabilityState);
    expect(states.find((s) => s.monitorId === archived)?.accountedThrough).toEqual(start);
    expect(states.find((s) => s.monitorId === paused)?.accountedThrough).toEqual(
      (await state()).accountedThrough,
    );
    expect(await repository.flushDue(2, 60_000)).toBe(0);
  });

  it("skips another writer's locked state while flushing other monitors", async () => {
    const other = (
      await new MonitorRepository(connection.db).create(
        organizationId,
        createMonitor({ name: 'Other', url: 'https://example.com' }),
      )
    ).id;
    const start = new Date('2026-01-01T00:00:00Z');
    await seed(start, 'UNKNOWN');
    await seed(start, 'UNKNOWN', other);
    const lock = await connection.pool.connect();
    try {
      await lock.query('begin');
      await lock.query(
        'select monitor_id from monitor_availability_state where monitor_id=$1 for update',
        [monitorId],
      );
      expect(await new AvailabilityRepository(connection.db).flushDue(2, 60_000)).toBe(1);
      expect((await state()).accountedThrough).toEqual(start);
      await lock.query('commit');
    } finally {
      await lock.query('rollback');
      lock.release();
    }
    expect(await new AvailabilityRepository(connection.db).flushDue(2, 60_000)).toBe(1);
  });

  it('does not double-account concurrent flushers and remains restart-idempotent', async () => {
    const start = new Date('2026-01-01T00:00:00Z');
    await seed(start, 'AVAILABLE');
    const counts = await Promise.all([
      new AvailabilityRepository(connection.db).flushDue(1, 60_000),
      new AvailabilityRepository(connection.db).flushDue(1, 60_000),
    ]);
    expect(counts.reduce((a, b) => a + b)).toBe(1);
    const rows = await daily();
    expect(rows.reduce((sum, row) => sum + total(row), 0)).toBe(
      (await state()).accountedThrough.getTime() - start.getTime(),
    );
    expect(await new AvailabilityRepository(connection.db).flushDue(1, 60_000)).toBe(0);
    expect(await daily()).toEqual(rows);
  });

  it.each(['completion', 'lifecycle', 'flush'] as const)(
    'rolls back %s entirely if daily accounting fails',
    async (operation) => {
      const round = await scheduled();
      const claim = await claimed(round.id);
      await seed(new Date('2026-01-01T00:00:00Z'), 'UNKNOWN');
      const initial = await state();
      const incidentBefore = await connection.db.select().from(monitorIncidentState);
      await connection.pool.query(
        `create function reject_availability() returns trigger language plpgsql as $$ begin raise exception 'test accounting failure'; end $$`,
      );
      await connection.pool.query(
        `create trigger reject_availability before insert on monitor_availability_daily for each row execute function reject_availability()`,
      );
      try {
        const action =
          operation === 'completion'
            ? new CheckExecutionRepository(connection.db).complete(
                claim.assignmentId,
                claim.claimToken,
                result({ outcome: 'FAIL', reason: 'UNEXPECTED_STATUS' }),
              )
            : operation === 'lifecycle'
              ? new MonitorRepository(connection.db).updateLifecycle(
                  organizationId,
                  monitorId,
                  'PAUSED',
                )
              : new AvailabilityRepository(connection.db).flushDue(1, 60_000);
        await expect(action).rejects.toThrow();
        expect(await state()).toEqual(initial);
        expect(await daily()).toEqual([]);
        expect(await connection.db.select().from(checkExecutionResults)).toEqual([]);
        expect(await connection.db.select().from(monitorIncidentState)).toEqual(incidentBefore);
        const [assignment] = await connection.db.select().from(checkExecutionAssignments);
        expect(assignment?.status).toBe('RUNNING');
        const [storedRound] = await connection.db.select().from(checkRounds);
        expect(storedRound?.status).toBe('PENDING');
        const [monitor] = await connection.db.select().from(monitors);
        expect(monitor?.lifecycleState).toBe('ENABLED');
      } finally {
        await connection.pool.query(
          'drop trigger reject_availability on monitor_availability_daily',
        );
        await connection.pool.query('drop function reject_availability()');
      }
    },
  );

  it('enforces duration bounds and tenant-safe foreign keys at the database boundary', async () => {
    const values = { organizationId, monitorId, dayUtc: '2026-01-01', updatedAt: new Date() };
    await expect(
      connection.db.insert(monitorAvailabilityDaily).values({ ...values, availableMs: -1 }),
    ).rejects.toThrow();
    await expect(
      connection.db
        .insert(monitorAvailabilityDaily)
        .values({ ...values, availableMs: dayMs, unknownMs: 1 }),
    ).rejects.toThrow();
    await expect(
      connection.db
        .insert(monitorAvailabilityDaily)
        .values({ ...values, organizationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }),
    ).rejects.toThrow();
  });

  it('rolls back daily UPSERTs if advancing the accumulator fails', async () => {
    await seed(new Date('2026-01-01T00:00:00Z'), 'UNKNOWN');
    const initial = await state();
    await connection.pool.query(
      `create function reject_watermark() returns trigger language plpgsql as $$ begin raise exception 'test watermark failure'; end $$`,
    );
    await connection.pool.query(
      `create trigger reject_watermark before update on monitor_availability_state for each row execute function reject_watermark()`,
    );
    try {
      await expect(new AvailabilityRepository(connection.db).flushDue(1, 1)).rejects.toThrow();
      expect(await daily()).toEqual([]);
      expect(await state()).toEqual(initial);
    } finally {
      await connection.pool.query('drop trigger reject_watermark on monitor_availability_state');
      await connection.pool.query('drop function reject_watermark()');
    }
  });

  function named(name: string) {
    const url = new URL(container.getConnectionUri());
    url.searchParams.set('application_name', name);
    return createDatabaseConnection(url.toString());
  }
  async function waitForLock(name: string) {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const waiting = await connection.pool.query<{ waiting: boolean }>(
        `select exists(select 1 from pg_stat_activity where application_name=$1 and wait_event_type='Lock') as waiting`,
        [name],
      );
      if (waiting.rows[0]?.waiting) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('Timed out waiting for PostgreSQL availability lock.');
  }

  async function state() {
    const [value] = await connection.db
      .select()
      .from(monitorAvailabilityState)
      .where(eq(monitorAvailabilityState.monitorId, monitorId));
    if (!value) throw new Error('Missing availability fixture.');
    return value;
  }
  async function daily() {
    return connection.db
      .select()
      .from(monitorAvailabilityDaily)
      .where(eq(monitorAvailabilityDaily.monitorId, monitorId))
      .orderBy(monitorAvailabilityDaily.dayUtc);
  }
  async function seed(at: Date, currentState: AvailabilityWindowState, id = monitorId) {
    await connection.db
      .update(monitorAvailabilityState)
      .set({
        currentState,
        trackingStartedAt: at,
        stateSince: at,
        accountedThrough: at,
        enabledSince: currentState === 'EXCLUDED' ? null : at,
      })
      .where(eq(monitorAvailabilityState.monitorId, id));
  }
  async function scheduled() {
    await connection.db
      .update(monitors)
      .set({ nextCheckAt: sql`clock_timestamp() - interval '1 second'` })
      .where(eq(monitors.id, monitorId));
    const [round] = await new ScheduledRoundRepository(connection.db).dispatchDue(1);
    if (!round) throw new Error('Missing scheduled fixture.');
    return round;
  }
  async function claimed(id: string) {
    const claim = await new CheckExecutionRepository(connection.db).claim(id, 45_000);
    if (claim.state !== 'CLAIMED') throw new Error('Missing execution claim.');
    return claim.execution;
  }
  async function complete(id: string, observation: AuthoritativeCheckResult) {
    const claim = await claimed(id);
    expect(
      await new CheckExecutionRepository(connection.db).complete(
        claim.assignmentId,
        claim.claimToken,
        observation,
      ),
    ).toBe(true);
  }
});

function total(row: typeof monitorAvailabilityDaily.$inferSelect): number {
  return row.availableMs + row.unavailableMs + row.unknownMs + row.excludedMs;
}
function result(overrides: Partial<AuthoritativeCheckResult> = {}): AuthoritativeCheckResult {
  return {
    outcome: 'PASS',
    stage: 'HTTP',
    reason: 'COMPLETED',
    statusCode: 200,
    responseTimeMs: 5,
    attemptDurationMs: 10,
    redirects: [],
    assertionEvaluation: EMPTY_ASSERTION_EVALUATION,
    checkedAt: new Date('2000-01-01T00:00:00Z'),
    ...overrides,
  };
}
