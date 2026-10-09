import 'reflect-metadata';
import { resolve } from 'node:path';
import { type INestApplication } from '@nestjs/common';
import { getDrizzleToken } from '@nestjs/drizzle';
import { Test } from '@nestjs/testing';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import {
  createDatabaseConnection,
  migrateDatabase,
  MonitorRepository,
  StatusPageRepository,
  type WatchrailDatabase,
} from '@watchrail/db';
import { createMonitor } from '@watchrail/domain';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { DEVELOPMENT_REQUEST_CONTEXT } from '../src/request-context.js';

const organizationB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

describe('status page settings API', () => {
  let app: INestApplication;
  let container: StartedPostgreSqlContainer;
  let database: WatchrailDatabase;
  let monitors: MonitorRepository;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:18.0-alpine').start();
    process.env.NODE_ENV = 'test';
    process.env.DATABASE_URL = container.getConnectionUri();
    process.env.DEV_IDENTITY_ENABLED = 'true';
    process.env.HTTP_HEADER_ACTIVE_KEY_ID = 'test';
    process.env.HTTP_HEADER_ENCRYPTION_KEYS = JSON.stringify({
      test: Buffer.alloc(32).toString('base64'),
    });
    process.env.ASSERTION_ACTIVE_KEY_ID = 'test';
    process.env.ASSERTION_ENCRYPTION_KEYS = JSON.stringify({
      test: Buffer.alloc(32).toString('base64'),
    });
    process.env.WEBHOOK_SIGNING_SECRET_ACTIVE_KEY_ID = 'test';
    process.env.WEBHOOK_SIGNING_SECRET_ENCRYPTION_KEYS = JSON.stringify({
      test: Buffer.alloc(32).toString('base64'),
    });
    const migration = createDatabaseConnection(container.getConnectionUri());
    await migrateDatabase(migration, resolve(process.cwd(), '../../packages/db/drizzle'));
    await migration.pool.end();
    const module = await Test.createTestingModule({ imports: [AppModule] }).compile();
    database = module.get<WatchrailDatabase>(getDrizzleToken());
    monitors = new MonitorRepository(database);
    app = module.createNestApplication();
    app.setGlobalPrefix('api');
    await app.init();
  }, 60_000);

  beforeEach(async () => {
    await database.$client.query('truncate status_pages, monitors cascade');
  });

  afterAll(async () => {
    await app?.close();
    await container?.stop();
  });

  it('creates, lists, reads, updates, publishes, and replaces private settings', async () => {
    const api = await createMonitorFor(DEVELOPMENT_REQUEST_CONTEXT.organizationId, 'API');
    const created = (
      await request(app.getHttpServer())
        .post('/api/status-pages')
        .send({
          name: 'Acme Status',
          slug: 'acme',
          components: [{ displayName: 'API', monitorId: api.id, position: 0 }],
        })
        .expect(201)
    ).body.data;
    expect(created).toMatchObject({
      name: 'Acme Status',
      slug: 'acme',
      published: false,
      components: [{ displayName: 'API', monitorId: api.id, position: 0 }],
    });
    expect(created).not.toHaveProperty('organizationId');
    expect(
      (await request(app.getHttpServer()).get('/api/status-pages').expect(200)).body.data,
    ).toEqual([created]);
    expect(
      (await request(app.getHttpServer()).get(`/api/status-pages/${created.id}`).expect(200)).body
        .data,
    ).toEqual(created);
    const renamed = (
      await request(app.getHttpServer())
        .patch(`/api/status-pages/${created.id}/settings`)
        .send({ name: 'Acme Services', slug: 'acme-services' })
        .expect(200)
    ).body.data;
    expect(renamed).toMatchObject({ name: 'Acme Services', slug: 'acme-services' });
    const emptied = (
      await request(app.getHttpServer())
        .put(`/api/status-pages/${created.id}/components`)
        .send({ components: [] })
        .expect(200)
    ).body.data;
    expect(emptied.components).toEqual([]);
    const published = (
      await request(app.getHttpServer())
        .patch(`/api/status-pages/${created.id}/publication`)
        .send({ published: true })
        .expect(200)
    ).body.data;
    expect(published).toMatchObject({ published: true, components: [] });
  });

  it('returns an explicit conflict for a globally reserved unpublished slug', async () => {
    await new StatusPageRepository(database).create(organizationB, {
      name: 'Other',
      slug: 'reserved',
      components: [],
    });
    const response = await request(app.getHttpServer())
      .post('/api/status-pages')
      .send({ name: 'Acme', slug: 'reserved', components: [] })
      .expect(409);
    expect(response.body).toMatchObject({ code: 'STATUS_PAGE_SLUG_TAKEN' });
  });

  it('uses request context ownership and hides foreign pages as not found', async () => {
    const foreign = await new StatusPageRepository(database).create(organizationB, {
      name: 'Foreign',
      slug: 'foreign',
      components: [],
    });
    await request(app.getHttpServer()).get(`/api/status-pages/${foreign.id}`).expect(404);
    await request(app.getHttpServer())
      .post('/api/status-pages')
      .send({
        organizationId: organizationB,
        name: 'Injected',
        slug: 'injected',
        components: [],
      })
      .expect(400);
    expect(await new StatusPageRepository(database).listForOrganization(organizationB)).toEqual([
      foreign,
    ]);
  });

  it('rejects invalid component replacement without changing the prior configuration', async () => {
    const api = await createMonitorFor(DEVELOPMENT_REQUEST_CONTEXT.organizationId, 'API');
    const created = (
      await request(app.getHttpServer())
        .post('/api/status-pages')
        .send({
          name: 'Acme',
          slug: 'acme',
          components: [{ displayName: 'API', monitorId: api.id, position: 0 }],
        })
        .expect(201)
    ).body.data;
    await request(app.getHttpServer())
      .put(`/api/status-pages/${created.id}/components`)
      .send({
        components: [
          {
            displayName: 'Missing',
            monitorId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
            position: 0,
          },
        ],
      })
      .expect(400);
    const current = (
      await request(app.getHttpServer()).get(`/api/status-pages/${created.id}`).expect(200)
    ).body.data;
    expect(current.components).toEqual(created.components);
  });

  async function createMonitorFor(organizationId: string, name: string) {
    return monitors.create(
      organizationId,
      createMonitor({ name, url: `https://${name.toLowerCase()}.example.com/health` }),
    );
  }
});
