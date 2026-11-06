import 'reflect-metadata';
import { resolve } from 'node:path';
import { type INestApplication } from '@nestjs/common';
import { getDrizzleToken } from '@nestjs/drizzle';
import { Test } from '@nestjs/testing';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import {
  createDatabaseConnection,
  MaintenanceWindowRepository,
  migrateDatabase,
  ProjectRepository,
  type WatchrailDatabase,
} from '@watchrail/db';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { DEVELOPMENT_REQUEST_CONTEXT } from '../src/auth/request-context.js';

describe('maintenance windows API', () => {
  let app: INestApplication;
  let container: StartedPostgreSqlContainer;
  let database: WatchrailDatabase;
  let projectId: string;

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
    process.env.WORKSPACE_SECRET_ACTIVE_KEY_ID = 'test';
    process.env.WORKSPACE_SECRET_ENCRYPTION_KEYS = JSON.stringify({
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
    await app.listen(0, '127.0.0.1');
  }, 60_000);

  beforeEach(async () => {
    await database.$client.query('truncate maintenance_windows, projects cascade');
    projectId = (
      await new ProjectRepository(database).create(DEVELOPMENT_REQUEST_CONTEXT.organizationId, {
        name: 'Launch project',
        slug: 'launch-project',
      })
    ).id;
  });

  afterAll(async () => {
    await app?.close();
    await container?.stop();
  });

  it('creates, versions, audits, lists, and archives a project window', async () => {
    const created = await request(app.getHttpServer())
      .post(`/api/projects/${projectId}/maintenance-windows`)
      .send(input('Launch maintenance'))
      .expect(201);
    expect(created.body.data).toMatchObject({
      projectId,
      versionNumber: 1,
      name: 'Launch maintenance',
      target: { type: 'PROJECT' },
    });

    const id = created.body.data.id as string;
    const updated = await request(app.getHttpServer())
      .patch(`/api/projects/${projectId}/maintenance-windows/${id}`)
      .send(input('Launch maintenance revised'))
      .expect(200);
    expect(updated.body.data).toMatchObject({
      versionNumber: 2,
      name: 'Launch maintenance revised',
    });
    const list = await request(app.getHttpServer())
      .get(`/api/projects/${projectId}/maintenance-windows`)
      .expect(200);
    expect(list.body.data).toHaveLength(1);
    const audit = await request(app.getHttpServer())
      .get(`/api/projects/${projectId}/maintenance-windows/${id}/audit-events`)
      .expect(200);
    expect(audit.body.data.map((event: { action: string }) => event.action)).toEqual([
      'CREATED',
      'UPDATED',
    ]);

    await request(app.getHttpServer())
      .delete(`/api/projects/${projectId}/maintenance-windows/${id}`)
      .expect(200);
    const empty = await request(app.getHttpServer())
      .get(`/api/projects/${projectId}/maintenance-windows`)
      .expect(200);
    expect(empty.body.data).toEqual([]);
  });

  it('returns field validation and hides foreign-tenant windows', async () => {
    const invalid = await request(app.getHttpServer())
      .post(`/api/projects/${projectId}/maintenance-windows`)
      .send({
        ...input('Invalid'),
        effects: { ...input('Invalid').effects, excludeFromUptime: false },
      })
      .expect(400);
    expect(invalid.body).toMatchObject({
      code: 'VALIDATION_FAILED',
      fields: { effects: expect.any(Array) },
    });

    const foreignOrganizationId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const foreignProject = await new ProjectRepository(database).create(foreignOrganizationId, {
      name: 'Foreign',
      slug: 'foreign',
    });
    const foreign = await new MaintenanceWindowRepository(database).create(
      foreignOrganizationId,
      foreignProject.id,
      '22222222-2222-4222-8222-222222222222',
      input('Foreign maintenance'),
    );
    await request(app.getHttpServer())
      .get(`/api/projects/${foreignProject.id}/maintenance-windows/${foreign.id}`)
      .expect(404);
  });
});

function input(name: string) {
  const start = new Date(Date.now() + 60 * 60_000);
  return {
    name,
    schedule: {
      type: 'ONE_TIME',
      startsAt: start.toISOString(),
      endsAt: new Date(start.getTime() + 60 * 60_000).toISOString(),
    },
    target: { type: 'PROJECT' },
    effects: {
      suppressNotifications: false,
      suppressIncidentCreation: false,
      excludeFromUptime: true,
      publishToStatusPage: false,
    },
  };
}
