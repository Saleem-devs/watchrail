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
  PublicStatusPageRepository,
  StatusPageRepository,
  type WatchrailDatabase,
} from '@watchrail/db';
import { createMonitor } from '@watchrail/domain';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
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
    process.env.PUBLIC_STATUS_PAGE_INTERNAL_TOKEN = 'test-internal-status-page-token-0001';
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
    expect(response.headers['cache-control']).toBe('public, max-age=30, stale-while-revalidate=30');
    expect(response.headers.etag).toMatch(/^W\/"[A-Za-z0-9_-]+"$/u);
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
    const notModified = await request(app.getHttpServer())
      .get('/api/public/status-pages/acme-status')
      .set('If-None-Match', response.headers.etag as string)
      .expect(304);
    expect(notModified.text).toBe('');
    expect(notModified.headers['cache-control']).toBe(
      'public, max-age=30, stale-while-revalidate=30',
    );
    expect(notModified.headers.etag).toBe(response.headers.etag);
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
    for (const response of [hidden, missing, invalid]) {
      expect(response.headers['cache-control']).toBe('no-store');
    }
  });

  it('serves SSR through a server-authenticated global-only limiter path', async () => {
    for (let index = 0; index < 31; index += 1) {
      await request(app.getHttpServer())
        .get('/api/internal/status-pages/acme-status')
        .set('x-watchrail-internal-token', 'test-internal-status-page-token-0001')
        .expect(200)
        .expect('Cache-Control', 'no-store');
    }
    await request(app.getHttpServer())
      .get('/api/internal/status-pages/acme-status')
      .expect(401)
      .expect('Cache-Control', 'no-store');
  });

  it('marks projection failures no-store', async () => {
    const repository = app.get(PublicStatusPageRepository);
    const failure = vi
      .spyOn(repository, 'findPublishedBySlug')
      .mockRejectedValueOnce(new Error('synthetic projection failure'));
    const response = await request(app.getHttpServer())
      .get('/api/public/status-pages/failing-page')
      .expect(500);
    expect(response.headers['cache-control']).toBe('no-store');
    failure.mockRestore();
  });

  it('throttles before lookup with a bounded Retry-After and no-store response', async () => {
    let throttled = false;
    for (let index = 0; index < 31; index += 1) {
      const response = await request(app.getHttpServer()).get(
        `/api/public/status-pages/missing-${index}`,
      );
      if (response.status === 429) {
        throttled = true;
        expect(response.body).toEqual({
          code: 'PUBLIC_RATE_LIMIT_EXCEEDED',
          message: 'Too many requests.',
        });
        expect(response.headers['cache-control']).toBe('no-store');
        expect(Number(response.headers['retry-after'])).toBeGreaterThanOrEqual(1);
        expect(Number(response.headers['retry-after'])).toBeLessThanOrEqual(60);
        break;
      }
    }
    expect(throttled).toBe(true);
  });
});
