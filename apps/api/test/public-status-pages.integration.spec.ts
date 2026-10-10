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
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';

const organizationId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

describe('public status page API', () => {
  let app: INestApplication;
  let container: StartedPostgreSqlContainer;
  let database: WatchrailDatabase;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:18.0-alpine').start();
    process.env.NODE_ENV = 'test';
    process.env.DATABASE_URL = container.getConnectionUri();
    process.env.DEV_IDENTITY_ENABLED = 'false';
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
    app = module.createNestApplication();
    app.setGlobalPrefix('api');
    await app.init();
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await container?.stop();
  });

  it('serves only published allow-listed data without authentication', async () => {
    const monitor = await new MonitorRepository(database).create(
      organizationId,
      createMonitor({ name: 'Private monitor', url: 'https://secret.example.com/health' }),
    );
    const configured = await new StatusPageRepository(database).create(organizationId, {
      name: 'Acme Status',
      slug: 'acme-status',
      published: true,
      components: [{ displayName: 'API', monitorId: monitor.id, position: 0 }],
    });
    const response = await request(app.getHttpServer())
      .get('/api/public/status-pages/acme-status')
      .expect(200);
    expect(response.body.data).toEqual({
      contractVersion: 1,
      name: 'Acme Status',
      slug: 'acme-status',
      status: 'MONITORING_IMPAIRED',
      components: [
        {
          id: configured.components[0]!.id,
          displayName: 'API',
          position: 0,
          status: 'MONITORING_IMPAIRED',
        },
      ],
      activeIncidents: [],
      resolvedIncidents: [],
      generatedAt: expect.any(String),
    });
    const serialized = JSON.stringify(response.body);
    for (const forbidden of [organizationId, monitor.id, 'secret.example.com', 'monitorId']) {
      expect(serialized).not.toContain(forbidden);
    }
    await request(app.getHttpServer()).get('/api/status-pages').expect(401);
  });

  it('returns the same not-found contract for unpublished, missing, and invalid slugs', async () => {
    await new StatusPageRepository(database).create(organizationId, {
      name: 'Hidden',
      slug: 'hidden-page',
      components: [],
    });
    const hidden = await request(app.getHttpServer())
      .get('/api/public/status-pages/hidden-page')
      .expect(404);
    const missing = await request(app.getHttpServer())
      .get('/api/public/status-pages/missing-page')
      .expect(404);
    const invalid = await request(app.getHttpServer())
      .get('/api/public/status-pages/INVALID')
      .expect(404);
    expect(hidden.body).toEqual(missing.body);
    expect(invalid.body).toEqual(missing.body);
    expect(missing.body).toMatchObject({ code: 'STATUS_PAGE_NOT_FOUND' });
  });
});
