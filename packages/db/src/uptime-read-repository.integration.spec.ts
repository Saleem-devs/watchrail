import { resolve } from 'node:path';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createMonitor,
  utcDayStart,
  type AvailabilityDurations,
  type AvailabilityWindowState,
} from '@watchrail/domain';
import { AvailabilityRepository } from './availability-repository.js';
import { createDatabaseConnection, type DatabaseConnection } from './client.js';
import { migrateDatabase } from './migration.js';
import { MonitorRepository } from './monitor-repository.js';
import { monitorAvailabilityDaily, monitorAvailabilityState } from './schema.js';
import {
  parseUptimeQuery,
  UptimeMonitorNotFoundError,
  UptimeQueryError,
  UptimeReadRepository,
} from './uptime-read-repository.js';

const org = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const otherOrg = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const dayMs = 86_400_000;

describe('read-only uptime projections', () => {
  let container: StartedPostgreSqlContainer;
  let connection: DatabaseConnection;
  let id: string;
  let today: Date;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:18.0-alpine').start();
    connection = createDatabaseConnection(container.getConnectionUri());
    await migrateDatabase(connection, resolve(process.cwd(), 'drizzle'));
  }, 60_000);
  beforeEach(async () => {
    await connection.pool.query('truncate monitors cascade');
    id = (
      await new MonitorRepository(connection.db).create(
        org,
        createMonitor({ name: 'Uptime', url: 'https://example.com' }),
      )
    ).id;
    const clock = await connection.pool.query<{ at: Date }>('select clock_timestamp() as at');
    today = utcDayStart(clock.rows[0]!.at);
  });
  afterAll(async () => {
    await connection?.pool.end();
    await container?.stop();
  });

  it.each(['AVAILABLE', 'UNAVAILABLE', 'UNKNOWN', 'EXCLUDED'] as const)(
    'includes an unflushed %s tail without writing anything',
    async (current) => {
      await seed(today, today, current);
      const stateBefore = await connection.db.select().from(monitorAvailabilityState);
      const repository = new UptimeReadRepository(connection.db);
      const metric = await repository.currentForMonitor(org, id, 'TODAY');
      const measured = new Date(metric.window.end).getTime() - today.getTime();
      const field = {
        AVAILABLE: 'availableMs',
        UNAVAILABLE: 'unavailableMs',
        UNKNOWN: 'unknownMs',
        EXCLUDED: 'excludedMs',
      } as const;
      expect(metric.durations[field[current]]).toBe(measured);
      expect(total(metric.durations)).toBe(measured);
      expect(metric.uptimePercent).toBe(
        current === 'AVAILABLE' ? 100 : current === 'UNAVAILABLE' ? 0 : null,
      );
      expect(metric.coveragePercent).toBe(
        current === 'EXCLUDED' ? null : current === 'UNKNOWN' ? 0 : 100,
      );
      expect(await connection.db.select().from(monitorAvailabilityState)).toEqual(stateBefore);
      expect(await connection.db.select().from(monitorAvailabilityDaily)).toEqual([]);
    },
  );

  it('combines a partially materialized UTC day and its tail exactly once', async () => {
    const start = new Date(today.getTime() - dayMs);
    const accounted = new Date(today.getTime() + 1);
    await seed(start, accounted, 'AVAILABLE');
    await bucket(start, {
      availableMs: dayMs - 120_000,
      unavailableMs: 60_000,
      unknownMs: 30_000,
      excludedMs: 30_000,
    });
    await bucket(today, { unknownMs: 1 });
    const repository = new UptimeReadRepository(connection.db);
    const metric = await repository.currentForMonitor(org, id, 'LAST_7_DAYS');
    const tail = new Date(metric.window.end).getTime() - accounted.getTime();
    expect(metric.durations).toEqual({
      availableMs: dayMs - 120_000 + tail,
      unavailableMs: 60_000,
      unknownMs: 30_001,
      excludedMs: 30_000,
    });
    expect(total(metric.durations)).toBe(new Date(metric.window.end).getTime() - start.getTime());
    const series = await repository.dailyForMonitor(org, id, 'LAST_7_DAYS');
    expect(series.days).toHaveLength(2);
    expect(series.days[0]?.durations).toEqual({
      availableMs: dayMs - 120_000,
      unavailableMs: 60_000,
      unknownMs: 30_000,
      excludedMs: 30_000,
    });
    expect(series.days[1]?.durations.availableMs).toBe(
      new Date(series.window.end).getTime() - accounted.getTime(),
    );
    expect(series.days[1]?.durations.unknownMs).toBe(1);
  });

  it('clips pre-tracking time and excludes paused time from both denominators', async () => {
    const start = new Date(today.getTime() - dayMs + 3_600_000);
    await seed(start, today, 'EXCLUDED');
    await bucket(new Date(today.getTime() - dayMs), {
      availableMs: 3_600_000,
      unavailableMs: 3_600_000,
      unknownMs: 7_200_000,
      excludedMs: 68_400_000,
    });
    const metric = await new UptimeReadRepository(connection.db).currentForMonitor(
      org,
      id,
      'LAST_30_DAYS',
    );
    expect(metric.window.start).toBe(start.toISOString());
    expect(metric.uptimePercent).toBe(50);
    expect(metric.coveragePercent).toBe(50);
    expect(total(metric.durations)).toBe(new Date(metric.window.end).getTime() - start.getTime());
    const series = await new UptimeReadRepository(connection.db).dailyForMonitor(org, id);
    expect(series.days).toHaveLength(2);
    expect(series.days[0]?.window.start).toBe(start.toISOString());
    expect(series.days[1]).toMatchObject({ uptimePercent: null, coveragePercent: null });
  });

  it('derives an archived terminal EXCLUDED tail across multiple days and keeps it readable', async () => {
    const start = new Date(today.getTime() - 3 * dayMs);
    const archivedAt = new Date(start.getTime() + 60_000);
    await new MonitorRepository(connection.db).updateLifecycle(org, id, 'ARCHIVED');
    await connection.db.delete(monitorAvailabilityDaily);
    await seed(start, archivedAt, 'EXCLUDED');
    await bucket(start, { availableMs: 60_000 });
    const metric = await new UptimeReadRepository(connection.db).currentForMonitor(org, id);
    expect(metric.uptimePercent).toBe(100);
    expect(metric.coveragePercent).toBe(100);
    expect(metric.durations.excludedMs).toBe(
      new Date(metric.window.end).getTime() - archivedAt.getTime(),
    );
    const series = await new UptimeReadRepository(connection.db).dailyForMonitor(
      org,
      id,
      'LAST_7_DAYS',
    );
    expect(series.days).toHaveLength(4);
    expect(series.days[1]).toMatchObject({
      durations: { excludedMs: dayMs },
      uptimePercent: null,
      coveragePercent: null,
    });
  });

  it.each([
    ['TODAY', 1],
    ['LAST_7_DAYS', 7],
    ['LAST_30_DAYS', 30],
  ] as const)('uses the %s UTC calendar boundary, not trailing hours', async (window, days) => {
    const start = new Date(today.getTime() - 40 * dayMs);
    await seed(start, start, 'UNKNOWN');
    const metric = await new UptimeReadRepository(connection.db).currentForMonitor(org, id, window);
    expect(metric.window.start).toBe(new Date(today.getTime() - (days - 1) * dayMs).toISOString());
    expect(metric.durations.unknownMs).toBe(
      new Date(metric.window.end).getTime() - new Date(metric.window.start).getTime(),
    );
    const series = await new UptimeReadRepository(connection.db).dailyForMonitor(org, id, window);
    expect(series.days).toHaveLength(days);
    for (const entry of series.days.slice(0, -1)) expect(total(entry.durations)).toBe(dayMs);
  });

  it('uses one cutoff for every organization projection and isolates organizations', async () => {
    const second = (
      await new MonitorRepository(connection.db).create(
        org,
        createMonitor({ name: 'Second', url: 'https://example.com' }),
      )
    ).id;
    const foreign = (
      await new MonitorRepository(connection.db).create(
        otherOrg,
        createMonitor({ name: 'Foreign', url: 'https://example.com' }),
      )
    ).id;
    await seed(today, today, 'AVAILABLE');
    await seed(today, today, 'AVAILABLE', second);
    const projections = await new UptimeReadRepository(connection.db).currentForOrganization(org);
    expect(projections.size).toBe(2);
    expect(projections.get(id)).toEqual(projections.get(second));
    expect(projections.has(foreign)).toBe(false);
    await expect(
      new UptimeReadRepository(connection.db).currentForMonitor(org, foreign),
    ).rejects.toBeInstanceOf(UptimeMonitorNotFoundError);
    await expect(
      new UptimeReadRepository(connection.db).dailyForMonitor(otherOrg, id),
    ).rejects.toBeInstanceOf(UptimeMonitorNotFoundError);
  });

  it('pins a read snapshot before a concurrent flush commits, preventing mixed row/tail versions', async () => {
    const start = new Date(today.getTime() - dayMs);
    await seed(start, start, 'AVAILABLE');
    const reader = createDatabaseConnection(container.getConnectionUri());
    let signal!: () => void;
    let release!: () => void;
    const established = new Promise<void>((resolve) => {
      signal = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const transaction = reader.db.transaction.bind(reader.db);
    const spy = vi.spyOn(reader.db, 'transaction').mockImplementation((callback, config) =>
      transaction(async (tx) => {
        const execute = tx.execute.bind(tx);
        vi.spyOn(tx, 'execute').mockImplementationOnce((query) => {
          const raw = execute(query);
          const run = raw.execute.bind(raw);
          vi.spyOn(raw, 'execute').mockImplementationOnce(async () => {
            const result = await run();
            signal();
            await gate;
            return result;
          });
          return raw;
        });
        return callback(tx);
      }, config),
    );
    const reading = new UptimeReadRepository(reader.db).currentForMonitor(org, id);
    try {
      await established;
      expect(await new AvailabilityRepository(connection.db).flushDue(1, 1)).toBe(1);
      release();
      const metric = await reading;
      expect(metric.durations.availableMs).toBe(
        new Date(metric.window.end).getTime() - start.getTime(),
      );
      expect(total(metric.durations)).toBe(metric.durations.availableMs);
    } finally {
      release();
      await reading;
      spy.mockRestore();
      await reader.pool.end();
    }
  });

  it('fails on missing accumulator state rather than inventing 100% uptime', async () => {
    await connection.db
      .delete(monitorAvailabilityState)
      .where(eq(monitorAvailabilityState.monitorId, id));
    await expect(
      new UptimeReadRepository(connection.db).currentForMonitor(org, id),
    ).rejects.toThrow('Monitor availability state is missing.');
  });

  async function seed(
    tracking: Date,
    accounted: Date,
    state: AvailabilityWindowState,
    monitorId = id,
  ) {
    await connection.db
      .update(monitorAvailabilityState)
      .set({
        trackingStartedAt: tracking,
        stateSince: accounted,
        accountedThrough: accounted,
        enabledSince: state === 'EXCLUDED' ? null : tracking,
        currentState: state,
      })
      .where(eq(monitorAvailabilityState.monitorId, monitorId));
  }
  async function bucket(day: Date, durations: Partial<AvailabilityDurations>) {
    await connection.db.insert(monitorAvailabilityDaily).values({
      organizationId: org,
      monitorId: id,
      dayUtc: day.toISOString().slice(0, 10),
      updatedAt: new Date(),
      ...durations,
    });
  }
});

describe('uptime query contract', () => {
  it.each([
    ['today', 'TODAY'],
    ['7d', 'LAST_7_DAYS'],
    ['30d', 'LAST_30_DAYS'],
  ] as const)('parses %s', (value, expected) =>
    expect(parseUptimeQuery({ window: value })).toBe(expected),
  );
  it('uses explicit defaults', () => {
    expect(parseUptimeQuery({})).toBe('LAST_7_DAYS');
    expect(parseUptimeQuery({}, 'LAST_30_DAYS')).toBe('LAST_30_DAYS');
  });
  it.each([
    { window: '24h' },
    { window: ['7d', '30d'] },
    { window: 7 },
    { window: null },
    { window: '' },
    { from: '2026-01-01' },
    { window: '7d', extra: true },
  ])('rejects invalid query %#', (query) =>
    expect(() => parseUptimeQuery(query)).toThrow(UptimeQueryError),
  );
});
function total(value: AvailabilityDurations): number {
  return value.availableMs + value.unavailableMs + value.unknownMs + value.excludedMs;
}
