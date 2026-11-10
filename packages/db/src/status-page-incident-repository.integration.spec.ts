import { resolve } from 'node:path';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createMonitor } from '@watchrail/domain';
import { createDatabaseConnection, type DatabaseConnection } from './client.js';
import { migrateDatabase } from './migration.js';
import { MonitorRepository } from './monitor-repository.js';
import {
  StatusPageIncidentComponentSelectionError,
  StatusPageIncidentRepository,
  StatusPageIncidentTransitionError,
} from './status-page-incident-repository.js';
import { StatusPageRepository } from './status-page-repository.js';

const organizationA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const organizationB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const actor = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

describe('StatusPageIncidentRepository', () => {
  let container: StartedPostgreSqlContainer;
  let connection: DatabaseConnection;
  let pages: StatusPageRepository;
  let incidents: StatusPageIncidentRepository;
  let monitors: MonitorRepository;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:18.0-alpine').start();
    connection = createDatabaseConnection(container.getConnectionUri());
    await migrateDatabase(connection, resolve(process.cwd(), 'drizzle'));
    pages = new StatusPageRepository(connection.db);
    incidents = new StatusPageIncidentRepository(connection.db);
    monitors = new MonitorRepository(connection.db);
  }, 60_000);

  beforeEach(async () => {
    await connection.pool.query('truncate status_pages, monitors cascade');
  });

  afterAll(async () => {
    await connection?.pool.end();
    await container?.stop();
  });

  it('creates an incident with a component snapshot and append-only ordered updates', async () => {
    const page = await createPage(organizationA, 'public-api');
    const created = await incidents.create(organizationA, page.id, actor, {
      title: 'API requests are failing',
      impact: 'DOWN',
      message: 'We are investigating elevated API failures.',
      componentIds: [page.components[0]!.id],
    });
    expect(created).toMatchObject({
      title: 'API requests are failing',
      state: 'INVESTIGATING',
      components: [{ displayName: 'Public API', position: 0 }],
      updates: [{ sequence: 1, state: 'INVESTIGATING' }],
    });

    await pages.replaceComponents(organizationA, page.id, [
      { displayName: 'Renamed API', monitorId: page.components[0]!.monitorId, position: 0 },
    ]);
    const identified = await incidents.appendUpdate(organizationA, page.id, created.id, actor, {
      state: 'IDENTIFIED',
      message: 'A database connection limit is causing requests to fail.',
    });
    const resolved = await incidents.appendUpdate(organizationA, page.id, created.id, actor, {
      state: 'RESOLVED',
      message: 'Connection capacity has been restored.',
    });
    expect(identified.components[0]!.displayName).toBe('Public API');
    expect(resolved.updates.map(({ sequence, state }) => [sequence, state])).toEqual([
      [1, 'INVESTIGATING'],
      [2, 'IDENTIFIED'],
      [3, 'RESOLVED'],
    ]);
    expect(resolved.resolvedAt).not.toBeNull();
  });

  it('rejects foreign components and hides incidents across tenants', async () => {
    const pageA = await createPage(organizationA, 'tenant-a');
    const pageB = await createPage(organizationB, 'tenant-b');
    await expect(
      incidents.create(organizationA, pageA.id, actor, {
        title: 'Invalid scope',
        impact: 'DEGRADED',
        message: 'This must not cross tenant boundaries.',
        componentIds: [pageB.components[0]!.id],
      }),
    ).rejects.toBeInstanceOf(StatusPageIncidentComponentSelectionError);
    const created = await incidents.create(organizationA, pageA.id, actor, {
      title: 'Scoped incident',
      impact: 'DEGRADED',
      message: 'This belongs to tenant A.',
      componentIds: [pageA.components[0]!.id],
    });
    await expect(incidents.find(organizationB, pageA.id, created.id)).resolves.toBeNull();
    await expect(incidents.list(organizationB, pageA.id)).rejects.toBeTruthy();
  });

  it('serializes concurrent resolution and records the terminal state once', async () => {
    const page = await createPage(organizationA, 'concurrency');
    const created = await incidents.create(organizationA, page.id, actor, {
      title: 'Concurrent update',
      impact: 'DEGRADED',
      message: 'Investigation started.',
      componentIds: [page.components[0]!.id],
    });
    const outcomes = await Promise.allSettled([
      incidents.appendUpdate(organizationA, page.id, created.id, actor, {
        state: 'RESOLVED',
        message: 'First operator resolved the incident.',
      }),
      incidents.appendUpdate(organizationA, page.id, created.id, actor, {
        state: 'RESOLVED',
        message: 'Second operator resolved the incident.',
      }),
    ]);
    expect(outcomes.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.find(({ status }) => status === 'rejected')).toMatchObject({
      reason: expect.any(StatusPageIncidentTransitionError),
    });
    expect((await incidents.find(organizationA, page.id, created.id))!.updates).toHaveLength(2);
  });

  async function createPage(organizationId: string, slug: string) {
    const monitor = await monitors.create(
      organizationId,
      createMonitor({ name: 'API', url: `https://${slug}.example.com/health` }),
    );
    return pages.create(organizationId, {
      name: `${slug} status`,
      slug,
      published: true,
      components: [{ displayName: 'Public API', monitorId: monitor.id, position: 0 }],
    });
  }
});
