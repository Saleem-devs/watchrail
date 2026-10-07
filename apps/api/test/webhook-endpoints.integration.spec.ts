import 'reflect-metadata';
import { resolve } from 'node:path';
import { type INestApplication } from '@nestjs/common';
import { getDrizzleToken } from '@nestjs/drizzle';
import { Test } from '@nestjs/testing';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import {
  createDatabaseConnection,
  migrateDatabase,
  WebhookEndpointRepository,
} from '@watchrail/db';
import type { WatchrailDatabase } from '@watchrail/db';
import {
  decryptWebhookSigningSecret,
  encryptWebhookSigningSecret,
  type EncryptedWebhookSigningSecretV1,
} from '@watchrail/webhook-security';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { APP_CONFIG, type AppConfig } from '../src/config.js';
import { DEVELOPMENT_REQUEST_CONTEXT } from '../src/request-context.js';

const sentinel = 'WATCHRAIL_WEBHOOK_SENTINEL_SECRET_123456789';

describe('webhook endpoint API', () => {
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
    process.env.WEBHOOK_SIGNING_SECRET_ACTIVE_KEY_ID = 'active';
    process.env.WEBHOOK_SIGNING_SECRET_ENCRYPTION_KEYS = JSON.stringify({
      old: Buffer.alloc(32, 1).toString('base64'),
      active: Buffer.alloc(32, 2).toString('base64'),
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
  }, 60_000);

  beforeEach(async () => {
    await database.$client.query('truncate webhook_endpoints cascade');
  });

  afterAll(async () => {
    await app?.close();
    await container?.stop();
  });

  it('creates, lists, and reads redacted endpoint settings with encrypted storage', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const created = await createEndpoint();
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
    expect(created).toMatchObject({
      name: 'Operations',
      url: 'https://hooks.example.com/watchrail',
      enabled: true,
      versionNumber: 1,
      signingSecret: { hasValue: true },
    });
    expect(JSON.stringify(created)).not.toContain(sentinel);
    for (const forbidden of ['ciphertext', 'authTag', 'keyId', 'iv'])
      expect(JSON.stringify(created)).not.toContain(forbidden);
    const [stored] = await versions(created.id);
    expect(JSON.stringify(stored)).not.toContain(sentinel);
    expect(
      decryptWebhookSigningSecret(
        stored!.signingSecretEnvelope,
        {
          organizationId: DEVELOPMENT_REQUEST_CONTEXT.organizationId,
          endpointId: created.id,
          versionNumber: 1,
        },
        config.webhookSigningSecretKeyring,
      ),
    ).toBe(sentinel);
    const listed = await request(app.getHttpServer()).get('/api/webhook-endpoints').expect(200);
    const detail = await request(app.getHttpServer())
      .get(`/api/webhook-endpoints/${created.id}`)
      .expect(200);
    expect(listed.body.data).toEqual([created]);
    expect(detail.body.data).toEqual(created);
  });

  it('keeps metadata changes idempotent and versions URL, retained secret, and rotations', async () => {
    const created = await createEndpoint();
    const renamed = await patchSettings(created.id, {
      name: 'Primary operations',
      url: created.url,
      signingSecret: { retain: true },
    });
    expect(renamed).toMatchObject({ name: 'Primary operations', versionNumber: 1 });
    const unchanged = await patchSettings(created.id, {
      name: 'Primary operations',
      url: created.url,
      signingSecret: { retain: true },
    });
    expect(unchanged.updatedAt).toBe(renamed.updatedAt);
    expect(await versions(created.id)).toHaveLength(1);

    const moved = await patchSettings(created.id, {
      name: 'Primary operations',
      url: 'https://hooks.example.com/watchrail/v2',
      signingSecret: { retain: true },
    });
    expect(moved.versionNumber).toBe(2);
    const afterRetain = await versions(created.id);
    expect(afterRetain).toHaveLength(2);
    for (const version of afterRetain)
      expect(
        decryptWebhookSigningSecret(
          version.signingSecretEnvelope,
          {
            organizationId: DEVELOPMENT_REQUEST_CONTEXT.organizationId,
            endpointId: created.id,
            versionNumber: version.versionNumber,
          },
          config.webhookSigningSecretKeyring,
        ),
      ).toBe(sentinel);
    expect(afterRetain[0]!.signingSecretEnvelope.ciphertext).not.toBe(
      afterRetain[1]!.signingSecretEnvelope.ciphertext,
    );

    const rotatedSecret = 'ROTATED_WEBHOOK_SIGNING_SECRET_123456789';
    const rotated = await patchSettings(created.id, {
      name: 'Primary operations',
      url: moved.url,
      signingSecret: { value: rotatedSecret },
    });
    expect(rotated.versionNumber).toBe(3);
    const stored = await versions(created.id);
    expect(stored[2]!.signingSecretEnvelope.keyId).toBe('active');
    expect(
      decryptWebhookSigningSecret(
        stored[2]!.signingSecretEnvelope,
        {
          organizationId: DEVELOPMENT_REQUEST_CONTEXT.organizationId,
          endpointId: created.id,
          versionNumber: 3,
        },
        config.webhookSigningSecretKeyring,
      ),
    ).toBe(rotatedSecret);
  });

  it('does not create versions when enabling or disabling and keeps disabled endpoints editable', async () => {
    const created = await createEndpoint();
    const disabled = await request(app.getHttpServer())
      .patch(`/api/webhook-endpoints/${created.id}/enabled`)
      .send({ enabled: false })
      .expect(200);
    expect(disabled.body.data).toMatchObject({ enabled: false, versionNumber: 1 });
    const edited = await patchSettings(created.id, {
      name: 'Disabled but editable',
      url: created.url,
      signingSecret: { retain: true },
    });
    expect(edited).toMatchObject({
      enabled: false,
      name: 'Disabled but editable',
      versionNumber: 1,
    });
    expect(await versions(created.id)).toHaveLength(1);
  });

  it('serializes concurrent configuration updates into distinct decryptable versions', async () => {
    const created = await createEndpoint();
    const [first, second] = await Promise.all([
      patchSettings(created.id, {
        name: 'Operations A',
        url: 'https://hooks.example.com/a',
        signingSecret: { retain: true },
      }),
      patchSettings(created.id, {
        name: 'Operations B',
        url: 'https://hooks.example.com/b',
        signingSecret: { retain: true },
      }),
    ]);
    expect(new Set([first.versionNumber, second.versionNumber])).toEqual(new Set([2, 3]));
    const stored = await versions(created.id);
    expect(stored.map((version) => version.versionNumber)).toEqual([1, 2, 3]);
    for (const version of stored)
      expect(
        decryptWebhookSigningSecret(
          version.signingSecretEnvelope,
          {
            organizationId: DEVELOPMENT_REQUEST_CONTEXT.organizationId,
            endpointId: created.id,
            versionNumber: version.versionNumber,
          },
          config.webhookSigningSecretKeyring,
        ),
      ).toBe(sentinel);
  });

  it('rolls back retained-secret updates when the old encryption key is unavailable', async () => {
    const repository = new WebhookEndpointRepository(database);
    const oldKeyring = {
      activeKeyId: 'old',
      keys: config.webhookSigningSecretKeyring.keys,
    };
    const endpoint = await repository.create(
      DEVELOPMENT_REQUEST_CONTEXT.organizationId,
      { name: 'Old key endpoint', url: 'https://hooks.example.com/old' },
      ({ endpointId, versionNumber }) =>
        encryptWebhookSigningSecret(
          sentinel,
          {
            organizationId: DEVELOPMENT_REQUEST_CONTEXT.organizationId,
            endpointId,
            versionNumber,
          },
          oldKeyring,
        ),
    );
    const keys = config.webhookSigningSecretKeyring.keys as Map<string, Buffer>;
    const oldKey = keys.get('old')!;
    keys.delete('old');
    try {
      await request(app.getHttpServer())
        .patch(`/api/webhook-endpoints/${endpoint.id}/settings`)
        .send({
          name: endpoint.name,
          url: 'https://hooks.example.com/new',
          signingSecret: { retain: true },
        })
        .expect(500);
    } finally {
      keys.set('old', oldKey);
    }
    expect(await versions(endpoint.id)).toHaveLength(1);
    const unchanged = await request(app.getHttpServer())
      .get(`/api/webhook-endpoints/${endpoint.id}`)
      .expect(200);
    expect(unchanged.body.data).toMatchObject({
      url: 'https://hooks.example.com/old',
      versionNumber: 1,
    });
  });

  it('isolates organizations and rejects malformed settings without exposing secrets', async () => {
    const foreignOrganizationId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const repository = new WebhookEndpointRepository(database);
    const foreign = await repository.create(
      foreignOrganizationId,
      { name: 'Foreign', url: 'https://foreign.example.com/events' },
      ({ endpointId, versionNumber }) =>
        encryptWebhookSigningSecret(
          sentinel,
          { organizationId: foreignOrganizationId, endpointId, versionNumber },
          config.webhookSigningSecretKeyring,
        ),
    );
    await request(app.getHttpServer()).get(`/api/webhook-endpoints/${foreign.id}`).expect(404);
    await request(app.getHttpServer())
      .patch(`/api/webhook-endpoints/${foreign.id}/enabled`)
      .send({ enabled: false })
      .expect(404);
    expect((await request(app.getHttpServer()).get('/api/webhook-endpoints')).body.data).toEqual(
      [],
    );

    for (const body of [
      { name: '', url: 'https://hooks.example.com', signingSecret: sentinel },
      { name: 'Bad', url: 'ftp://example.com', signingSecret: sentinel },
      { name: 'Bad', url: 'https://user:pass@example.com', signingSecret: sentinel },
      { name: 'Bad', url: 'https://example.com', signingSecret: 'short' },
      { name: 'Bad', url: 'https://example.com', signingSecret: sentinel, extra: true },
    ])
      await request(app.getHttpServer()).post('/api/webhook-endpoints').send(body).expect(400);
    const created = await createEndpoint();
    for (const signingSecret of [
      undefined,
      {},
      { retain: false },
      { value: sentinel, retain: true },
    ])
      await request(app.getHttpServer())
        .patch(`/api/webhook-endpoints/${created.id}/settings`)
        .send({ name: created.name, url: created.url, signingSecret })
        .expect(400);
    expect(JSON.stringify(await versions(created.id))).not.toContain(sentinel);
  });

  async function createEndpoint() {
    const response = await request(app.getHttpServer())
      .post('/api/webhook-endpoints')
      .send({
        name: 'Operations',
        url: 'https://hooks.example.com/watchrail',
        signingSecret: sentinel,
        enabled: true,
      })
      .expect(201);
    return response.body.data as {
      id: string;
      name: string;
      url: string;
      enabled: boolean;
      versionNumber: number;
      signingSecret: { hasValue: true };
      createdAt: string;
      updatedAt: string;
    };
  }

  async function patchSettings(endpointId: string, body: object) {
    const response = await request(app.getHttpServer())
      .patch(`/api/webhook-endpoints/${endpointId}/settings`)
      .send(body)
      .expect(200);
    return response.body.data as Awaited<ReturnType<typeof createEndpoint>>;
  }

  async function versions(endpointId: string) {
    const result = await database.$client.query<{
      versionNumber: number;
      signingSecretEnvelope: EncryptedWebhookSigningSecretV1;
    }>(
      'select version_number as "versionNumber", signing_secret_envelope as "signingSecretEnvelope" from webhook_endpoint_versions where endpoint_id=$1 order by version_number',
      [endpointId],
    );
    return result.rows;
  }
});
