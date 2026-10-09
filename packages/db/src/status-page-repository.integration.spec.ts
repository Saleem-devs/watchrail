import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createMonitor } from '@watchrail/domain';
import { createDatabaseConnection, type DatabaseConnection } from './client.js';
import { migrateDatabase } from './migration.js';
import { MonitorRepository } from './monitor-repository.js';
import { statusPageComponents } from './schema.js';
import {
  StatusPageMonitorSelectionError,
  StatusPageRepository,
  StatusPageSlugTakenError,
} from './status-page-repository.js';

const organizationA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const organizationB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

describe('StatusPageRepository', () => {
  let container: StartedPostgreSqlContainer;
  let connection: DatabaseConnection;
  let pages: StatusPageRepository;
  let monitors: MonitorRepository;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:18.0-alpine').start();
    connection = createDatabaseConnection(container.getConnectionUri());
    await migrateDatabase(connection, resolve(process.cwd(), 'drizzle'));
    pages = new StatusPageRepository(connection.db);
    monitors = new MonitorRepository(connection.db);
  }, 60_000);

  beforeEach(async () => {
    await connection.pool.query('truncate status_pages, monitors cascade');
  });

  afterAll(async () => {
    await connection?.pool.end();
    await container?.stop();
  });

  it('persists an unpublished page and normalized component order', async () => {
    const api = await createMonitorFor(organizationA, 'API');
    const web = await createMonitorFor(organizationA, 'Web');
    const page = await pages.create(organizationA, {
      name: 'Acme Status',
      slug: 'acme',
      components: [
        { displayName: 'Dashboard', monitorId: web.id, position: 1 },
        { displayName: 'API', monitorId: api.id, position: 0 },
      ],
    });
    expect(page).toMatchObject({
      organizationId: organizationA,
      name: 'Acme Status',
      slug: 'acme',
      published: false,
    });
    expect(page.components.map(({ displayName }) => displayName)).toEqual(['API', 'Dashboard']);
    expect(await pages.listForOrganization(organizationA)).toEqual([page]);
    expect(await pages.findForOrganization(organizationA, page.id)).toEqual(page);
    expect(await pages.findForOrganization(organizationB, page.id)).toBeNull();
  });

  it('lets only one concurrent creator reserve a global slug, including unpublished pages', async () => {
    const outcomes = await Promise.allSettled([
      pages.create(organizationA, {
        name: 'A',
        slug: 'shared-status',
        components: [],
      }),
      pages.create(organizationB, {
        name: 'B',
        slug: 'shared-status',
        components: [],
      }),
    ]);
    expect(outcomes.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
    const rejected = outcomes.find(({ status }) => status === 'rejected');
    expect(rejected).toMatchObject({ reason: expect.any(StatusPageSlugTakenError) });
  });

  it('releases the previous slug after a settings change', async () => {
    const page = await pages.create(organizationA, {
      name: 'Acme',
      slug: 'acme-old',
      components: [],
    });
    await pages.updateSettings(organizationA, page.id, { name: 'Acme', slug: 'acme-new' });
    await expect(
      pages.create(organizationB, { name: 'Other', slug: 'acme-old', components: [] }),
    ).resolves.toMatchObject({ slug: 'acme-old' });
  });

  it('preserves component identity and makes identical replacement retry-safe', async () => {
    const api = await createMonitorFor(organizationA, 'API');
    const web = await createMonitorFor(organizationA, 'Web');
    const replacement = await createMonitorFor(organizationA, 'Replacement');
    const page = await pages.create(organizationA, {
      name: 'Acme',
      slug: 'acme',
      components: [
        { displayName: 'API', monitorId: api.id, position: 0 },
        { displayName: 'Web', monitorId: web.id, position: 1 },
      ],
    });
    const apiId = page.components[0]!.id;
    const webId = page.components[1]!.id;

    const identical = await pages.replaceComponents(organizationA, page.id, [
      { displayName: 'API', monitorId: api.id, position: 0 },
      { displayName: 'Web', monitorId: web.id, position: 1 },
    ]);
    expect(identical.components.map(({ id }) => id)).toEqual([apiId, webId]);
    expect(identical.updatedAt).toEqual(page.updatedAt);

    const renamedAndReordered = await pages.replaceComponents(organizationA, page.id, [
      { displayName: 'Website', monitorId: web.id, position: 0 },
      { displayName: 'Public API', monitorId: api.id, position: 1 },
    ]);
    expect(renamedAndReordered.components).toMatchObject([
      { id: webId, displayName: 'Website', monitorId: web.id, position: 0 },
      { id: apiId, displayName: 'Public API', monitorId: api.id, position: 1 },
    ]);

    const changedMembership = await pages.replaceComponents(organizationA, page.id, [
      { displayName: 'Public API', monitorId: api.id, position: 0 },
      { displayName: 'Replacement', monitorId: replacement.id, position: 1 },
    ]);
    expect(changedMembership.components[0]!.id).toBe(apiId);
    expect(changedMembership.components[1]!.id).not.toBe(webId);
  });

  it('rejects foreign and newly archived monitors before replacing existing components', async () => {
    const original = await createMonitorFor(organizationA, 'Original');
    const foreign = await createMonitorFor(organizationB, 'Foreign');
    const archived = await createMonitorFor(organizationA, 'Archived');
    await monitors.updateLifecycle(organizationA, archived.id, 'ARCHIVED');
    const page = await pages.create(organizationA, {
      name: 'Acme',
      slug: 'acme',
      components: [{ displayName: 'Original', monitorId: original.id, position: 0 }],
    });
    for (const monitorId of [foreign.id, archived.id]) {
      await expect(
        pages.replaceComponents(organizationA, page.id, [
          { displayName: 'Invalid', monitorId, position: 0 },
        ]),
      ).rejects.toBeInstanceOf(StatusPageMonitorSelectionError);
      expect(
        (await pages.findForOrganization(organizationA, page.id))!.components[0]!.monitorId,
      ).toBe(original.id);
    }
  });

  it('keeps a selected monitor after it is archived and allows paused monitors', async () => {
    const selected = await createMonitorFor(organizationA, 'Selected');
    const paused = await createMonitorFor(organizationA, 'Paused');
    await monitors.updateLifecycle(organizationA, paused.id, 'PAUSED');
    const page = await pages.create(organizationA, {
      name: 'Acme',
      slug: 'acme',
      components: [
        { displayName: 'Selected', monitorId: selected.id, position: 0 },
        { displayName: 'Paused', monitorId: paused.id, position: 1 },
      ],
    });
    await monitors.updateLifecycle(organizationA, selected.id, 'ARCHIVED');
    const replaced = await pages.replaceComponents(organizationA, page.id, [
      { displayName: 'Archived but retained', monitorId: selected.id, position: 0 },
      { displayName: 'Paused', monitorId: paused.id, position: 1 },
    ]);
    expect(replaced.components).toHaveLength(2);
  });

  it('enforces tenant-safe component foreign keys in PostgreSQL', async () => {
    const foreign = await createMonitorFor(organizationB, 'Foreign');
    const page = await pages.create(organizationA, {
      name: 'Acme',
      slug: 'acme',
      components: [],
    });
    await expect(
      connection.db.insert(statusPageComponents).values({
        id: randomUUID(),
        organizationId: organizationA,
        statusPageId: page.id,
        monitorId: foreign.id,
        displayName: 'Foreign',
        position: 0,
      }),
    ).rejects.toBeTruthy();
    await expect(
      connection.db.insert(statusPageComponents).values({
        id: randomUUID(),
        organizationId: organizationB,
        statusPageId: page.id,
        monitorId: foreign.id,
        displayName: 'Wrong page tenant',
        position: 0,
      }),
    ).rejects.toBeTruthy();
  });

  it('changes publication without mutating components', async () => {
    const monitor = await createMonitorFor(organizationA, 'API');
    const page = await pages.create(organizationA, {
      name: 'Acme',
      slug: 'acme',
      components: [{ displayName: 'API', monitorId: monitor.id, position: 0 }],
    });
    const published = await pages.setPublished(organizationA, page.id, true);
    expect(published.published).toBe(true);
    expect(published.components).toEqual(page.components);
    expect(
      await connection.db
        .select()
        .from(statusPageComponents)
        .where(eq(statusPageComponents.statusPageId, page.id)),
    ).toHaveLength(1);
  });

  async function createMonitorFor(organizationId: string, name: string) {
    return monitors.create(
      organizationId,
      createMonitor({ name, url: `https://${name.toLowerCase()}.example.com/health` }),
    );
  }
});
