import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createMonitor,
  EMPTY_ASSERTION_CONFIGURATION,
  type MaintenanceWindowEffects,
  type MaintenanceWindowSchedule,
} from '@watchrail/domain';
import { accrueAvailability } from './availability-repository.js';
import { createDatabaseConnection, type DatabaseConnection } from './client.js';
import { MaintenancePolicyRepository } from './maintenance-policy.js';
import {
  MaintenanceWindowRepository,
  MaintenanceWindowTargetError,
} from './maintenance-window-repository.js';
import { migrateDatabase } from './migration.js';
import { MonitorRepository } from './monitor-repository.js';
import { ProjectRepository } from './project-repository.js';
import {
  maintenanceWindowVersions,
  monitorAvailabilityDaily,
  monitorAvailabilityState,
} from './schema.js';
import { UptimeReadRepository } from './uptime-read-repository.js';

const organizationA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const organizationB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const actorId = '11111111-1111-4111-8111-111111111111';

describe('maintenance windows', () => {
  let container: StartedPostgreSqlContainer;
  let connection: DatabaseConnection;
  let windows: MaintenanceWindowRepository;
  let monitors: MonitorRepository;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:18.0-alpine').start();
    connection = createDatabaseConnection(container.getConnectionUri());
    await migrateDatabase(connection, resolve(process.cwd(), 'drizzle'));
    windows = new MaintenanceWindowRepository(connection.db);
    monitors = new MonitorRepository(connection.db);
  }, 60_000);

  beforeEach(async () => {
    await connection.pool.query('truncate maintenance_windows, monitors cascade');
  });

  afterAll(async () => {
    await connection?.pool.end();
    await container?.stop();
  });

  it('versions edits, target bindings, archival, and audit history atomically', async () => {
    const monitor = await createMonitorFor(organizationA, 'API');
    const created = await windows.create(
      organizationA,
      monitor.projectId,
      actorId,
      input({ target: { type: 'MONITORS', monitorIds: [monitor.id] } }),
    );
    expect(created).toMatchObject({ versionNumber: 1, target: { type: 'MONITORS' } });

    const updated = await windows.update(
      organizationA,
      monitor.projectId,
      created.id,
      actorId,
      input({ name: 'Database maintenance', target: { type: 'PROJECT' } }),
    );
    expect(updated).toMatchObject({ versionNumber: 2, name: 'Database maintenance' });
    expect(await connection.db.select().from(maintenanceWindowVersions)).toHaveLength(2);
    expect(
      (await windows.listAuditHistory(organizationA, monitor.projectId, created.id)).map(
        ({ action }) => action,
      ),
    ).toEqual(['CREATED', 'UPDATED']);

    const archived = await windows.archive(organizationA, monitor.projectId, created.id, actorId);
    expect(archived.archivedAt).not.toBeNull();
    expect(await windows.listForProject(organizationA, monitor.projectId)).toEqual([]);
    expect(
      (await windows.listAuditHistory(organizationA, monitor.projectId, created.id)).map(
        ({ action }) => action,
      ),
    ).toEqual(['CREATED', 'UPDATED', 'ARCHIVED']);
  });

  it('rejects cross-project and cross-tenant monitor targets', async () => {
    const owner = await createMonitorFor(organizationA, 'Owner');
    const otherProjectRecord = await new ProjectRepository(connection.db).create(organizationA, {
      name: 'Other project',
      slug: 'other-project',
    });
    const otherProject = await monitors.create(
      organizationA,
      randomUUID(),
      createMonitor({ name: 'Other project', url: 'https://other.example.com' }),
      [],
      EMPTY_ASSERTION_CONFIGURATION,
      otherProjectRecord.id,
    );
    const foreign = await createMonitorFor(organizationB, 'Foreign');
    for (const monitorId of [otherProject.id, foreign.id]) {
      await expect(
        windows.create(
          organizationA,
          owner.projectId,
          actorId,
          input({ target: { type: 'MONITORS', monitorIds: [monitorId] } }),
        ),
      ).rejects.toBeInstanceOf(MaintenanceWindowTargetError);
    }
  });

  it('unions overlapping windows and excludes exact intervals from uptime', async () => {
    const monitor = await createMonitorFor(organizationA, 'Availability');
    const origin = new Date(Date.now() + 60 * 60 * 1_000);
    const end = new Date(origin.getTime() + 2 * 60 * 60 * 1_000);
    const firstStart = new Date(origin.getTime() + 30 * 60 * 1_000);
    const firstEnd = new Date(origin.getTime() + 75 * 60 * 1_000);
    const secondStart = new Date(origin.getTime() + 60 * 60 * 1_000);
    const secondEnd = new Date(origin.getTime() + 90 * 60 * 1_000);
    await windows.create(
      organizationA,
      monitor.projectId,
      actorId,
      input({
        name: 'First',
        schedule: oneTime(firstStart, firstEnd),
        effects: effects({ suppressNotifications: true }),
      }),
    );
    await windows.create(
      organizationA,
      monitor.projectId,
      actorId,
      input({
        name: 'Second',
        schedule: oneTime(secondStart, secondEnd),
        effects: effects({ suppressIncidentCreation: true }),
      }),
    );

    const policy = await new MaintenancePolicyRepository(connection.db).activeForMonitor(
      organizationA,
      monitor.projectId,
      monitor.id,
      new Date(origin.getTime() + 65 * 60 * 1_000),
    );
    expect(policy.windows.map(({ name }) => name).sort()).toEqual(['First', 'Second']);
    expect(policy.effects).toMatchObject({
      suppressNotifications: true,
      suppressIncidentCreation: true,
      excludeFromUptime: true,
    });

    await connection.db
      .update(monitorAvailabilityState)
      .set({
        currentState: 'AVAILABLE',
        stateSince: origin,
        accountedThrough: origin,
        trackingStartedAt: origin,
        enabledSince: origin,
        updatedAt: origin,
      })
      .where(eq(monitorAvailabilityState.monitorId, monitor.id));
    await connection.db.transaction(async (tx) => {
      const [state] = await tx
        .select()
        .from(monitorAvailabilityState)
        .where(eq(monitorAvailabilityState.monitorId, monitor.id))
        .for('update');
      await accrueAvailability(tx, state!, end);
    });
    const daily = await connection.db
      .select()
      .from(monitorAvailabilityDaily)
      .where(eq(monitorAvailabilityDaily.monitorId, monitor.id));
    expect(daily.reduce((total, row) => total + row.excludedMs, 0)).toBe(60 * 60 * 1_000);
    expect(daily.reduce((total, row) => total + row.availableMs, 0)).toBe(60 * 60 * 1_000);
  });

  it('keeps accrued uptime immutable across an active edit and archival', async () => {
    const monitor = await createMonitorFor(organizationA, 'Immutable uptime');
    const clock = await databaseClock();
    const origin = new Date(clock.getTime() - 2 * 60_000);
    const created = await windows.create(
      organizationA,
      monitor.projectId,
      actorId,
      input({
        schedule: oneTime(origin, new Date(clock.getTime() + 60 * 60_000)),
        effects: effects({ excludeFromUptime: true }),
      }),
    );
    await connection.db
      .update(monitorAvailabilityState)
      .set({
        currentState: 'AVAILABLE',
        stateSince: origin,
        accountedThrough: origin,
        trackingStartedAt: origin,
        enabledSince: origin,
        updatedAt: origin,
      })
      .where(eq(monitorAvailabilityState.monitorId, monitor.id));

    await accrueTo(monitor.id, await databaseClock());
    const [beforeEdit] = await connection.db
      .select()
      .from(monitorAvailabilityDaily)
      .where(eq(monitorAvailabilityDaily.monitorId, monitor.id));
    expect(beforeEdit!.excludedMs).toBeGreaterThan(0);

    const updated = await windows.update(
      organizationA,
      monitor.projectId,
      created.id,
      actorId,
      input({
        schedule: created.schedule,
        effects: effects({ excludeFromUptime: false, suppressNotifications: true }),
      }),
    );
    expect(updated.effectiveAt.getTime()).toBeGreaterThanOrEqual(created.effectiveAt.getTime());
    await accrueTo(monitor.id, await databaseClock());
    const [atEditBoundary] = await connection.db
      .select()
      .from(monitorAvailabilityDaily)
      .where(eq(monitorAvailabilityDaily.monitorId, monitor.id));
    expect(atEditBoundary!.excludedMs).toBeGreaterThanOrEqual(beforeEdit!.excludedMs);
    const archived = await windows.archive(organizationA, monitor.projectId, created.id, actorId);
    expect(archived.archivedAt).not.toBeNull();
    await accrueTo(monitor.id, await databaseClock());

    const [afterArchive] = await connection.db
      .select()
      .from(monitorAvailabilityDaily)
      .where(eq(monitorAvailabilityDaily.monitorId, monitor.id));
    expect(afterArchive!.excludedMs).toBe(atEditBoundary!.excludedMs);
    expect(afterArchive!.availableMs).toBeGreaterThanOrEqual(atEditBoundary!.availableMs);
    const historical = await new UptimeReadRepository(connection.db).currentForMonitor(
      organizationA,
      monitor.id,
      'TODAY',
    );
    expect(historical.durations.excludedMs).toBe(atEditBoundary!.excludedMs);
    expect(
      historical.durations.availableMs +
        historical.durations.unavailableMs +
        historical.durations.unknownMs +
        historical.durations.excludedMs,
    ).toBe(new Date(historical.window.end).getTime() - origin.getTime());
  });

  it('uses identical DST and overlapping-recurrence semantics for lookup and uptime enumeration', async () => {
    const monitor = await createMonitorFor(organizationA, 'Recurring policy');
    const spring = await windows.create(
      organizationA,
      monitor.projectId,
      actorId,
      input({
        name: 'Spring transition',
        schedule: recurring('America/New_York', '02:30', [0], 30, '2026-03-01', '2026-03-15'),
      }),
    );
    const fall = await windows.create(
      organizationA,
      monitor.projectId,
      actorId,
      input({
        name: 'Fall transition',
        schedule: recurring('America/New_York', '01:30', [0], 30, '2026-10-25', '2026-11-08'),
      }),
    );
    const overlapping = await windows.create(
      organizationA,
      monitor.projectId,
      actorId,
      input({
        name: 'Overlapping recurrence',
        schedule: recurring('UTC', '00:00', [1, 2], 2 * 24 * 60, '2026-11-01', '2026-11-30'),
      }),
    );
    await connection.db
      .update(maintenanceWindowVersions)
      .set({ effectiveAt: new Date('2026-01-01T00:00:00.000Z') });
    const policies = new MaintenancePolicyRepository(connection.db);

    const springPolicy = await policies.activeForMonitor(
      organizationA,
      monitor.projectId,
      monitor.id,
      new Date('2026-03-08T07:35:00.000Z'),
    );
    expect(springPolicy.windows).toEqual([
      expect.objectContaining({
        id: spring.id,
        occurrence: {
          startsAt: new Date('2026-03-08T07:30:00.000Z'),
          endsAt: new Date('2026-03-08T08:00:00.000Z'),
        },
      }),
    ]);
    expect(
      await policies.exclusionIntervalsForMonitor(
        organizationA,
        monitor.projectId,
        monitor.id,
        new Date('2026-03-08T00:00:00.000Z'),
        new Date('2026-03-09T00:00:00.000Z'),
      ),
    ).toEqual([
      {
        startsAt: new Date('2026-03-08T07:30:00.000Z'),
        endsAt: new Date('2026-03-08T08:00:00.000Z'),
      },
    ]);
    expect(
      (
        await policies.activeForMonitor(
          organizationA,
          monitor.projectId,
          monitor.id,
          new Date('2026-11-01T05:35:00.000Z'),
        )
      ).windows.map(({ id }) => id),
    ).toContain(fall.id);
    expect(
      (
        await policies.activeForMonitor(
          organizationA,
          monitor.projectId,
          monitor.id,
          new Date('2026-11-01T06:35:00.000Z'),
        )
      ).windows.map(({ id }) => id),
    ).not.toContain(fall.id);
    expect(
      await policies.exclusionIntervalsForMonitor(
        organizationA,
        monitor.projectId,
        monitor.id,
        new Date('2026-11-02T00:00:00.000Z'),
        new Date('2026-11-05T00:00:00.000Z'),
      ),
    ).toEqual([
      {
        startsAt: new Date('2026-11-02T00:00:00.000Z'),
        endsAt: new Date('2026-11-05T00:00:00.000Z'),
      },
    ]);
    expect(overlapping.id).not.toBe(spring.id);
  });

  async function createMonitorFor(organizationId: string, name: string) {
    return monitors.create(
      organizationId,
      createMonitor({
        name,
        url: `https://${name.toLowerCase().replaceAll(' ', '-')}.example.com`,
      }),
    );
  }

  async function databaseClock() {
    const result = await connection.pool.query<{ at: Date }>('select clock_timestamp() as at');
    return result.rows[0]!.at;
  }

  async function accrueTo(monitorId: string, at: Date) {
    await connection.db.transaction(async (tx) => {
      const [state] = await tx
        .select()
        .from(monitorAvailabilityState)
        .where(eq(monitorAvailabilityState.monitorId, monitorId))
        .for('update');
      await accrueAvailability(tx, state!, at);
    });
  }
});

function input(
  overrides: Partial<{
    name: string;
    schedule: MaintenanceWindowSchedule;
    target: { type: 'PROJECT' } | { type: 'MONITORS'; monitorIds: string[] };
    effects: ReturnType<typeof effects>;
  }> = {},
) {
  const now = new Date(Date.now() + 60 * 60 * 1_000);
  return {
    name: overrides.name ?? 'Routine maintenance',
    schedule: overrides.schedule ?? oneTime(now, new Date(now.getTime() + 30 * 60 * 1_000)),
    target: overrides.target ?? ({ type: 'PROJECT' } as const),
    effects: overrides.effects ?? effects(),
  };
}

function recurring(
  timezone: string,
  localTime: string,
  daysOfWeek: number[],
  durationMinutes: number,
  startsOn: string,
  endsOn: string | null,
): MaintenanceWindowSchedule {
  return {
    type: 'RECURRING',
    timezone,
    localTime,
    daysOfWeek,
    durationMinutes,
    startsOn,
    endsOn,
  };
}

function oneTime(startsAt: Date, endsAt: Date) {
  return {
    type: 'ONE_TIME' as const,
    startsAt: startsAt.toISOString(),
    endsAt: endsAt.toISOString(),
  };
}

function effects(overrides: Partial<MaintenanceWindowEffects> = {}): MaintenanceWindowEffects {
  return {
    suppressNotifications: false,
    suppressIncidentCreation: false,
    excludeFromUptime: true,
    publishToStatusPage: false,
    ...overrides,
  };
}
