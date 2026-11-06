import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createMonitor,
  EMPTY_ASSERTION_CONFIGURATION,
  type MaintenanceWindowEffects,
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

  async function createMonitorFor(organizationId: string, name: string) {
    return monitors.create(
      organizationId,
      createMonitor({
        name,
        url: `https://${name.toLowerCase().replaceAll(' ', '-')}.example.com`,
      }),
    );
  }
});

function input(
  overrides: Partial<{
    name: string;
    schedule: ReturnType<typeof oneTime>;
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
