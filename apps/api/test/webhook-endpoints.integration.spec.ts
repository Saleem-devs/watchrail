import 'reflect-metadata';
import { resolve } from 'node:path';
import { type INestApplication } from '@nestjs/common';
import { getDrizzleToken } from '@nestjs/drizzle';
import { Test } from '@nestjs/testing';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import {
  CheckExecutionRepository,
  createDatabaseConnection,
  migrateDatabase,
  MonitorRepository,
  notificationDeliveries,
  notificationEvents,
  ScheduledRoundRepository,
  WebhookEndpointRepository,
  monitors,
  type AuthoritativeCheckResult,
} from '@watchrail/db';
import type { WatchrailDatabase } from '@watchrail/db';
import { createMonitor, EMPTY_ASSERTION_EVALUATION } from '@watchrail/domain';
import {
  decryptWebhookSigningSecret,
  encryptWebhookSigningSecret,
  type EncryptedWebhookSigningSecretV1,
} from '@watchrail/webhook-security';
import request from 'supertest';
import { eq, sql } from 'drizzle-orm';
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
    await database.$client.query('truncate webhook_endpoints, monitors cascade');
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
      .get(`/api/webhook-endpoints/${foreign.id}/deliveries`)
      .expect(404);
    await request(app.getHttpServer())
      .get('/api/webhook-endpoints/cccccccc-cccc-4ccc-8ccc-cccccccccccc/deliveries')
      .expect(404);
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

  it('reads paginated delivery history with immutable target context and no durable secrets', async () => {
    const endpoint = await createEndpoint();
    const monitor = await new MonitorRepository(database).create(
      DEVELOPMENT_REQUEST_CONTEXT.organizationId,
      createMonitor({ name: 'Payments API', url: 'https://example.com/health' }),
    );
    await completeScheduled(monitor.id, unhealthy());
    await completeScheduled(monitor.id, unhealthy());
    await completeScheduled(monitor.id, unhealthy());
    const [openedDelivery] = await database
      .select()
      .from(notificationDeliveries)
      .where(eq(notificationDeliveries.endpointId, endpoint.id));
    const [openedEvent] = await database
      .select()
      .from(notificationEvents)
      .where(eq(notificationEvents.id, openedDelivery!.eventId));
    await database.execute(sql`
      update notification_events
      set payload=${JSON.stringify({ ...(openedEvent!.payload as object), poison: true })}::jsonb
      where id=${openedEvent!.id}::uuid
    `);
    await database.execute(sql`
      update notification_deliveries set
        attempt_count=8,
        last_attempt_at=clock_timestamp(),
        last_error_code='HTTP_503',
        last_http_status=503,
        dead_at=clock_timestamp(),
        dead_reason='MAX_ATTEMPTS'
      where id=${openedDelivery!.id}::uuid
    `);
    await patchSettings(endpoint.id, {
      name: endpoint.name,
      url: 'https://hooks.example.com/watchrail/v2',
      signingSecret: { retain: true },
    });
    await completeScheduled(monitor.id, healthy());
    await request(app.getHttpServer())
      .patch(`/api/webhook-endpoints/${endpoint.id}/enabled`)
      .send({ enabled: false })
      .expect(200);
    const identicalTime = new Date('2026-10-07T09:12:00.000Z');
    await database
      .update(notificationDeliveries)
      .set({ createdAt: identicalTime })
      .where(eq(notificationDeliveries.endpointId, endpoint.id));
    const before = await database
      .select()
      .from(notificationDeliveries)
      .where(eq(notificationDeliveries.endpointId, endpoint.id));

    const first = await request(app.getHttpServer())
      .get(`/api/webhook-endpoints/${endpoint.id}/deliveries?limit=1`)
      .expect(200);
    expect(first.body.page.nextCursor).toEqual(expect.any(String));
    const second = await request(app.getHttpServer())
      .get(
        `/api/webhook-endpoints/${endpoint.id}/deliveries?limit=1&cursor=${first.body.page.nextCursor as string}`,
      )
      .expect(200);
    const items = [...first.body.data, ...second.body.data] as Array<{
      id: string;
      status: string;
      event: { type: string };
      deadReason: string | null;
      lastErrorCode: string | null;
      lastHttpStatus: number | null;
    }>;
    expect(new Set(items.map((item) => item.id)).size).toBe(2);
    expect(items.map((item) => item.event.type).sort()).toEqual([
      'INCIDENT_OPENED',
      'INCIDENT_RESOLVED',
    ]);
    expect(items.find((item) => item.id === openedDelivery!.id)).toMatchObject({
      status: 'DEAD',
      deadReason: 'MAX_ATTEMPTS',
      lastErrorCode: 'HTTP_503',
      lastHttpStatus: 503,
    });

    const detail = await request(app.getHttpServer())
      .get(`/api/webhook-endpoints/${endpoint.id}/deliveries/${openedDelivery!.id}`)
      .expect(200);
    expect(detail.body.data).toMatchObject({
      id: openedDelivery!.id,
      endpointId: endpoint.id,
      endpointVersion: {
        id: openedDelivery!.endpointVersionId,
        versionNumber: 1,
        url: endpoint.url,
      },
      triggeringRoundId: openedEvent!.triggeringRoundId,
    });
    const serialized = JSON.stringify({ items, detail: detail.body.data });
    for (const forbidden of [
      sentinel,
      'claimToken',
      'signingSecretEnvelope',
      'ciphertext',
      'authTag',
      'signature',
      'poison',
      'payload',
    ])
      expect(serialized).not.toContain(forbidden);
    expect(
      await database
        .select()
        .from(notificationDeliveries)
        .where(eq(notificationDeliveries.endpointId, endpoint.id)),
    ).toEqual(before);

    const empty = await createEndpoint();
    const emptyPage = await request(app.getHttpServer())
      .get(`/api/webhook-endpoints/${empty.id}/deliveries`)
      .expect(200);
    expect(emptyPage.body).toEqual({ data: [], page: { nextCursor: null } });
    await request(app.getHttpServer())
      .get(`/api/webhook-endpoints/${empty.id}/deliveries/${openedDelivery!.id}`)
      .expect(404);
    for (const query of ['limit=0', 'limit=101', 'limit=1.5', 'cursor=invalid', 'extra=true'])
      await request(app.getHttpServer())
        .get(`/api/webhook-endpoints/${endpoint.id}/deliveries?${query}`)
        .expect(400);
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

  async function completeScheduled(monitorId: string, result: AuthoritativeCheckResult) {
    await database
      .update(monitors)
      .set({ nextCheckAt: sql`clock_timestamp() - interval '1 second'` })
      .where(eq(monitors.id, monitorId));
    const [round] = await new ScheduledRoundRepository(database).dispatchDue(1);
    if (!round) throw new Error('Expected scheduled round.');
    const executions = new CheckExecutionRepository(database);
    const claim = await executions.claim(round.id, 45_000);
    if (claim.state !== 'CLAIMED') throw new Error('Expected execution claim.');
    expect(
      await executions.complete(claim.execution.assignmentId, claim.execution.claimToken, result),
    ).toBe(true);
  }
});

function checkResult(
  values: Partial<AuthoritativeCheckResult> &
    Pick<AuthoritativeCheckResult, 'outcome' | 'stage' | 'reason'>,
): AuthoritativeCheckResult {
  return {
    statusCode: null,
    responseTimeMs: null,
    attemptDurationMs: 10,
    redirects: [],
    assertionEvaluation: EMPTY_ASSERTION_EVALUATION,
    checkedAt: new Date(),
    ...values,
  };
}

function healthy(): AuthoritativeCheckResult {
  return checkResult({
    outcome: 'PASS',
    stage: 'HTTP',
    reason: 'COMPLETED',
    statusCode: 200,
    responseTimeMs: 5,
  });
}

function unhealthy(): AuthoritativeCheckResult {
  return checkResult({
    outcome: 'FAIL',
    stage: 'HTTP',
    reason: 'UNEXPECTED_STATUS',
    statusCode: 503,
    responseTimeMs: 5,
  });
}
