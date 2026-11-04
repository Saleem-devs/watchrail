import 'reflect-metadata';
import { resolve } from 'node:path';
import { type INestApplication } from '@nestjs/common';
import { getDrizzleToken } from '@nestjs/drizzle';
import { Test } from '@nestjs/testing';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import {
  createDatabaseConnection,
  migrateDatabase,
  workspaceSecretAuditEvents,
  workspaceSecretBindings,
  workspaceSecretVersions,
  workspaceSecrets,
  WorkspaceSecretRepository,
  eq,
  type WatchrailDatabase,
} from '@watchrail/db';
import { decryptWorkspaceSecret, encryptWorkspaceSecret } from '@watchrail/secret-vault-security';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { DEVELOPMENT_REQUEST_CONTEXT } from '../src/auth/request-context.js';
import { APP_CONFIG, type AppConfig } from '../src/config/config.js';

const sentinel = 'WATCHRAIL_WORKSPACE_SECRET_SENTINEL';

describe('workspace secrets API', () => {
  let app: INestApplication;
  let container: StartedPostgreSqlContainer;
  let database: WatchrailDatabase;
  let config: AppConfig;

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
    process.env.WORKSPACE_SECRET_ACTIVE_KEY_ID = 'active';
    process.env.WORKSPACE_SECRET_ENCRYPTION_KEYS = JSON.stringify({
      old: Buffer.alloc(32, 4).toString('base64'),
      active: Buffer.alloc(32, 5).toString('base64'),
    });

    const migration = createDatabaseConnection(container.getConnectionUri());
    await migrateDatabase(migration, resolve(process.cwd(), '../../packages/db/drizzle'));
    await migration.pool.end();

    const module = await Test.createTestingModule({ imports: [AppModule] }).compile();
    database = module.get<WatchrailDatabase>(getDrizzleToken());
    config = module.get<AppConfig>(APP_CONFIG);
    app = module.createNestApplication();
    app.setGlobalPrefix('api');
    await app.init();
    await app.listen(0, '127.0.0.1');
  }, 60_000);

  beforeEach(async () => {
    await database.$client.query('truncate workspace_secrets cascade');
  });

  afterAll(async () => {
    await app?.close();
    await container?.stop();
  });

  it('creates and reads masked metadata while storing only tenant-bound ciphertext', async () => {
    const created = await createSecret();
    expect(created).toMatchObject({
      key: 'STRIPE_API_KEY',
      description: 'Used by billing checks',
      versionNumber: 1,
      usageCount: 0,
      value: { hasValue: true },
      status: 'ACTIVE',
    });
    expect(JSON.stringify(created)).not.toContain(sentinel);
    expect(collectObjectKeys(created)).not.toEqual(
      expect.arrayContaining(['ciphertext', 'authTag', 'keyId', 'iv']),
    );

    const [stored] = await database
      .select()
      .from(workspaceSecretVersions)
      .where(eq(workspaceSecretVersions.secretId, created.id));
    expect(JSON.stringify(stored)).not.toContain(sentinel);
    expect(
      decryptWorkspaceSecret(
        stored!.encryptedValue,
        {
          organizationId: DEVELOPMENT_REQUEST_CONTEXT.organizationId,
          secretId: created.id,
          versionNumber: 1,
        },
        config.workspaceSecretKeyring,
      ),
    ).toBe(sentinel);

    const list = await request(app.getHttpServer()).get('/api/workspace-secrets').expect(200);
    const detail = await request(app.getHttpServer())
      .get(`/api/workspace-secrets/${created.id}`)
      .expect(200);
    expect(list.body.data).toEqual([created]);
    expect(detail.body.data).toEqual(created);
  });

  it('updates metadata without a new version and rotates values transactionally with audit history', async () => {
    const created = await createSecret();
    const updated = await request(app.getHttpServer())
      .patch(`/api/workspace-secrets/${created.id}`)
      .send({ description: 'Rotated by platform operations' })
      .expect(200);
    expect(updated.body.data).toMatchObject({ versionNumber: 1 });

    const replacement = 'WATCHRAIL_ROTATED_WORKSPACE_SECRET';
    const rotated = await request(app.getHttpServer())
      .post(`/api/workspace-secrets/${created.id}/rotations`)
      .send({ value: replacement })
      .expect(201);
    expect(rotated.body.data).toMatchObject({ versionNumber: 2 });

    const versions = await database
      .select()
      .from(workspaceSecretVersions)
      .where(eq(workspaceSecretVersions.secretId, created.id));
    expect(versions).toHaveLength(2);
    expect(
      versions.map((version) =>
        decryptWorkspaceSecret(
          version.encryptedValue,
          {
            organizationId: DEVELOPMENT_REQUEST_CONTEXT.organizationId,
            secretId: created.id,
            versionNumber: version.versionNumber,
          },
          config.workspaceSecretKeyring,
        ),
      ),
    ).toEqual([sentinel, replacement]);

    const audit = await request(app.getHttpServer())
      .get(`/api/workspace-secrets/${created.id}/audit-events`)
      .expect(200);
    expect(audit.body.data.map((event: { action: string }) => event.action)).toEqual([
      'ROTATED',
      'DESCRIPTION_UPDATED',
      'CREATED',
    ]);
    expect(JSON.stringify(audit.body)).not.toContain(sentinel);
  });

  it('blocks archival while referenced, then soft-deletes without removing versions or audit', async () => {
    const created = await createSecret();
    await database.insert(workspaceSecretBindings).values({
      organizationId: DEVELOPMENT_REQUEST_CONTEXT.organizationId,
      secretId: created.id,
      resourceType: 'MONITOR',
      resourceId: '30000000-0000-4000-8000-000000000003',
      resourcePath: 'requestHeaders.authorization',
    });

    const blocked = await request(app.getHttpServer())
      .delete(`/api/workspace-secrets/${created.id}`)
      .expect(409);
    expect(blocked.body).toMatchObject({ code: 'WORKSPACE_SECRET_IN_USE' });

    await database
      .delete(workspaceSecretBindings)
      .where(eq(workspaceSecretBindings.secretId, created.id));
    const archived = await request(app.getHttpServer())
      .delete(`/api/workspace-secrets/${created.id}`)
      .expect(200);
    expect(archived.body.data).toMatchObject({
      status: 'ARCHIVED',
      archivedAt: expect.any(String),
    });

    const active = await request(app.getHttpServer()).get('/api/workspace-secrets').expect(200);
    expect(active.body.data).toEqual([]);
    const all = await request(app.getHttpServer())
      .get('/api/workspace-secrets?includeArchived=true')
      .expect(200);
    expect(all.body.data).toHaveLength(1);
    expect(await database.select().from(workspaceSecretVersions)).toHaveLength(1);
    expect(await database.select().from(workspaceSecretAuditEvents)).toHaveLength(2);
  });

  it('enforces tenant scoping and key uniqueness without exposing internal storage errors', async () => {
    const created = await createSecret();
    const duplicate = await request(app.getHttpServer())
      .post('/api/workspace-secrets')
      .send({ key: 'stripe_api_key', value: 'replacement' })
      .expect(409);
    expect(duplicate.body).toMatchObject({ code: 'WORKSPACE_SECRET_KEY_EXISTS' });

    const otherOrganizationId = '40000000-0000-4000-8000-000000000004';
    const other = await new WorkspaceSecretRepository(database).create(
      otherOrganizationId,
      '50000000-0000-4000-8000-000000000005',
      { key: 'STRIPE_API_KEY' },
      ({ secretId, versionNumber }) =>
        encryptWorkspaceSecret(
          'other-tenant-secret',
          { organizationId: otherOrganizationId, secretId, versionNumber },
          config.workspaceSecretKeyring,
        ),
    );
    await request(app.getHttpServer()).get(`/api/workspace-secrets/${other.id}`).expect(404);
    await request(app.getHttpServer()).get(`/api/workspace-secrets/${created.id}`).expect(200);
  });

  it('returns field validation without retaining invalid values', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/workspace-secrets')
      .send({ key: 'invalid key', value: '' })
      .expect(400);
    expect(response.body).toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(JSON.stringify(response.body)).not.toContain('invalid key');
    expect(await database.select().from(workspaceSecrets)).toEqual([]);
  });

  async function createSecret() {
    const response = await request(app.getHttpServer())
      .post('/api/workspace-secrets')
      .send({
        key: 'stripe_api_key',
        description: 'Used by billing checks',
        value: sentinel,
      })
      .expect(201);
    return response.body.data as {
      id: string;
      key: string;
      description: string;
      versionNumber: number;
      usageCount: number;
      value: { hasValue: true };
      status: 'ACTIVE' | 'ARCHIVED';
      createdAt: string;
      updatedAt: string;
      archivedAt: string | null;
    };
  }
});

function collectObjectKeys(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(collectObjectKeys);
  if (typeof value !== 'object' || value === null) return [];
  return Object.entries(value).flatMap(([key, nested]) => [key, ...collectObjectKeys(nested)]);
}
