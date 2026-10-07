import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createMonitor, EMPTY_ASSERTION_EVALUATION } from '@watchrail/domain';
import {
  CheckExecutionRepository,
  type AuthoritativeCheckResult,
} from './check-execution-repository.js';
import { createDatabaseConnection, type DatabaseConnection } from './client.js';
import { migrateDatabase } from './migration.js';
import { MonitorRepository } from './monitor-repository.js';
import { ScheduledRoundRepository } from './scheduled-round-repository.js';
import { monitors, notificationDeliveries, notificationEvents } from './schema.js';
import {
  parseWebhookDeliveryHistoryQuery,
  WebhookDeliveryEndpointNotFoundError,
  WebhookDeliveryHistoryQueryError,
  WebhookDeliveryReadRepository,
} from './webhook-delivery-read-repository.js';
import { WebhookEndpointRepository } from './webhook-endpoint-repository.js';

const organizationId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const signingSecretEnvelope = {
  version: 1 as const,
  algorithm: 'AES-256-GCM' as const,
  keyId: 'test-v1',
  iv: Buffer.alloc(12, 1).toString('base64url'),
  ciphertext: Buffer.alloc(32, 2).toString('base64url'),
  authTag: Buffer.alloc(16, 3).toString('base64url'),
};

describe('WebhookDeliveryReadRepository', () => {
  let container: StartedPostgreSqlContainer;
  let connection: DatabaseConnection;
  let monitorId: string;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:18.0-alpine').start();
    connection = createDatabaseConnection(container.getConnectionUri());
    await migrateDatabase(connection, resolve(process.cwd(), 'drizzle'));
  }, 60_000);

  beforeEach(async () => {
    await connection.pool.query('truncate webhook_endpoints, monitors cascade');
    const monitor = await new MonitorRepository(connection.db).create(
      organizationId,
      createMonitor({ name: 'Payments API', url: 'https://example.com/health' }),
    );
    monitorId = monitor.id;
  });

  afterAll(async () => {
    await connection?.pool.end();
    await container?.stop();
  });

  it('derives pending, in-flight, expired, retry, delivered, and dead states at one cutoff', async () => {
    const endpoints = await Promise.all(
      ['pending', 'in-flight', 'expired', 'retry', 'delivered', 'dead'].map((name) =>
        createEndpoint(name, `https://${name}.example.com/events`),
      ),
    );
    await openIncident();
    const deliveries = await connection.db.select().from(notificationDeliveries);
    const byEndpoint = new Map(deliveries.map((delivery) => [delivery.endpointId, delivery]));
    const inFlight = byEndpoint.get(endpoints[1]!.id)!;
    const expired = byEndpoint.get(endpoints[2]!.id)!;
    const retry = byEndpoint.get(endpoints[3]!.id)!;
    const delivered = byEndpoint.get(endpoints[4]!.id)!;
    const dead = byEndpoint.get(endpoints[5]!.id)!;
    await connection.db.execute(sql`
      update notification_deliveries set
        claim_token=${randomUUID()}::uuid,
        attempt_count=1,
        last_attempt_at=clock_timestamp(),
        available_at=clock_timestamp() + interval '1 hour'
      where id=${inFlight.id}::uuid
    `);
    await connection.db.execute(sql`
      update notification_deliveries set
        claim_token=${randomUUID()}::uuid,
        attempt_count=1,
        last_attempt_at=clock_timestamp() - interval '2 hours',
        available_at=clock_timestamp() - interval '1 hour'
      where id=${expired.id}::uuid
    `);
    await connection.db.execute(sql`
      update notification_deliveries set
        attempt_count=2,
        last_attempt_at=clock_timestamp(),
        last_error_code='HTTP_503',
        last_http_status=503,
        available_at=clock_timestamp() + interval '1 hour'
      where id=${retry.id}::uuid
    `);
    await connection.db.execute(sql`
      update notification_deliveries set
        attempt_count=1,
        last_attempt_at=clock_timestamp(),
        last_http_status=204,
        delivered_at=clock_timestamp()
      where id=${delivered.id}::uuid
    `);
    await connection.db.execute(sql`
      update notification_deliveries set
        attempt_count=8,
        last_attempt_at=clock_timestamp(),
        last_error_code='HTTP_503',
        last_http_status=503,
        dead_at=clock_timestamp(),
        dead_reason='MAX_ATTEMPTS'
      where id=${dead.id}::uuid
    `);

    const repository = new WebhookDeliveryReadRepository(connection.db);
    const items = await Promise.all(
      endpoints.map(
        async (endpoint) =>
          (await repository.listForEndpoint(organizationId, endpoint.id, { limit: 25 })).items[0]!,
      ),
    );
    expect(items.map((item) => item.status)).toEqual([
      'PENDING',
      'IN_FLIGHT',
      'PENDING',
      'RETRY_SCHEDULED',
      'DELIVERED',
      'DEAD',
    ]);
    expect(items[1]).toMatchObject({ nextAttemptAt: null, leaseExpiresAt: expect.any(Date) });
    expect(items[2]).toMatchObject({ nextAttemptAt: null, leaseExpiresAt: null });
    expect(items[3]).toMatchObject({
      attemptCount: 2,
      lastAttemptAt: expect.any(Date),
      lastErrorCode: 'HTTP_503',
      lastHttpStatus: 503,
      nextAttemptAt: expect.any(Date),
      leaseExpiresAt: null,
    });
    expect(items[5]).toMatchObject({
      deadReason: 'MAX_ATTEMPTS',
      lastErrorCode: 'HTTP_503',
      lastHttpStatus: 503,
    });
  });

  it('reads poison dead letters and immutable historical endpoint versions without payload parsing', async () => {
    const endpoint = await createEndpoint('Operations', 'https://hooks.example.com/v1');
    await openIncident();
    const [delivery] = await connection.db.select().from(notificationDeliveries);
    const [event] = await connection.db.select().from(notificationEvents);
    await connection.db.execute(sql`
      update notification_events
      set payload=${JSON.stringify({ ...(event!.payload as object), poison: true })}::jsonb
      where id=${event!.id}::uuid
    `);
    await connection.db.execute(sql`
      update notification_deliveries set
        attempt_count=1,
        last_attempt_at=clock_timestamp(),
        last_error_code='INVALID_CONTRACT',
        dead_at=clock_timestamp(),
        dead_reason='INVALID_CONTRACT'
      where id=${delivery!.id}::uuid
    `);
    await new WebhookEndpointRepository(connection.db).updateSettings(
      organizationId,
      endpoint.id,
      { name: endpoint.name, url: 'https://hooks.example.com/v2', rotateSecret: true },
      () => ({ ...signingSecretEnvelope, keyId: 'test-v2' }),
    );
    await new WebhookEndpointRepository(connection.db).setEnabled(
      organizationId,
      endpoint.id,
      false,
    );

    const detail = await new WebhookDeliveryReadRepository(connection.db).findForEndpoint(
      organizationId,
      endpoint.id,
      delivery!.id,
    );
    expect(detail).toMatchObject({
      status: 'DEAD',
      endpointId: endpoint.id,
      endpointVersion: { id: delivery!.endpointVersionId, versionNumber: 1, url: endpoint.url },
      lastErrorCode: 'INVALID_CONTRACT',
      deadReason: 'INVALID_CONTRACT',
      triggeringRoundId: event!.triggeringRoundId,
    });
    expect(JSON.stringify(detail)).not.toContain('poison');
  });

  it('paginates identical timestamps deterministically and performs no delivery mutations', async () => {
    const endpoint = await createEndpoint('Operations', 'https://hooks.example.com/events');
    await openIncident();
    await complete((await scheduledRound()).id, healthy());
    const identicalTime = new Date('2026-10-07T09:12:00.000Z');
    await connection.db
      .update(notificationDeliveries)
      .set({ createdAt: identicalTime })
      .where(eq(notificationDeliveries.endpointId, endpoint.id));
    const before = await connection.db
      .select()
      .from(notificationDeliveries)
      .where(eq(notificationDeliveries.endpointId, endpoint.id));
    const repository = new WebhookDeliveryReadRepository(connection.db);

    const first = await repository.listForEndpoint(organizationId, endpoint.id, { limit: 1 });
    const second = await repository.listForEndpoint(organizationId, endpoint.id, {
      limit: 1,
      cursor: first.nextCursor!,
    });

    expect(first.nextCursor).not.toBeNull();
    expect(new Set([...first.items, ...second.items].map((item) => item.id)).size).toBe(2);
    expect([...first.items, ...second.items].map((item) => item.event.type).sort()).toEqual([
      'INCIDENT_OPENED',
      'INCIDENT_RESOLVED',
    ]);
    expect(
      await connection.db
        .select()
        .from(notificationDeliveries)
        .where(eq(notificationDeliveries.endpointId, endpoint.id)),
    ).toEqual(before);
  });

  it('isolates organizations and endpoints while keeping empty owned histories readable', async () => {
    const own = await createEndpoint('Own', 'https://own.example.com/events');
    const other = await createEndpoint('Other', 'https://other.example.com/events');
    const foreign = await new WebhookEndpointRepository(connection.db).create(
      'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      { name: 'Foreign', url: 'https://foreign.example.com/events' },
      () => signingSecretEnvelope,
    );
    const repository = new WebhookDeliveryReadRepository(connection.db);
    await expect(
      repository.listForEndpoint(organizationId, own.id, { limit: 25 }),
    ).resolves.toEqual({ items: [], nextCursor: null });
    await expect(
      repository.listForEndpoint(organizationId, foreign.id, { limit: 25 }),
    ).rejects.toBeInstanceOf(WebhookDeliveryEndpointNotFoundError);
    await openIncident();
    const [delivery] = await connection.db
      .select()
      .from(notificationDeliveries)
      .where(eq(notificationDeliveries.endpointId, other.id));
    await expect(
      repository.findForEndpoint(organizationId, own.id, delivery!.id),
    ).resolves.toBeNull();
  });

  function createEndpoint(name: string, url: string) {
    return new WebhookEndpointRepository(connection.db).create(
      organizationId,
      { name, url },
      () => signingSecretEnvelope,
    );
  }

  async function openIncident() {
    await complete((await scheduledRound()).id, unhealthy());
    await complete((await scheduledRound()).id, unhealthy());
    await complete((await scheduledRound()).id, unhealthy());
  }

  async function scheduledRound() {
    await connection.db
      .update(monitors)
      .set({ nextCheckAt: sql`clock_timestamp() - interval '1 second'` })
      .where(eq(monitors.id, monitorId));
    const [round] = await new ScheduledRoundRepository(connection.db).dispatchDue(1);
    if (!round) throw new Error('Expected scheduled round.');
    return round;
  }

  async function complete(roundId: string, result: AuthoritativeCheckResult) {
    const repository = new CheckExecutionRepository(connection.db);
    const claim = await repository.claim(roundId, 45_000);
    if (claim.state !== 'CLAIMED') throw new Error('Expected claim.');
    expect(
      await repository.complete(claim.execution.assignmentId, claim.execution.claimToken, result),
    ).toBe(true);
  }
});

describe('parseWebhookDeliveryHistoryQuery', () => {
  it('applies the default and accepts strict bounds', () => {
    expect(parseWebhookDeliveryHistoryQuery({})).toEqual({ limit: 25 });
    expect(parseWebhookDeliveryHistoryQuery({ limit: '100' })).toEqual({ limit: 100 });
  });

  it.each([
    { limit: '0' },
    { limit: '101' },
    { limit: '1.5' },
    { limit: 5 },
    { extra: 'true' },
    { cursor: '' },
    { cursor: 'not-a-cursor' },
  ])('rejects malformed query %#', (value) => {
    expect(() => parseWebhookDeliveryHistoryQuery(value)).toThrow(WebhookDeliveryHistoryQueryError);
  });
});

function result(
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
  return result({
    outcome: 'PASS',
    stage: 'HTTP',
    reason: 'COMPLETED',
    statusCode: 200,
    responseTimeMs: 5,
  });
}

function unhealthy(): AuthoritativeCheckResult {
  return result({
    outcome: 'FAIL',
    stage: 'HTTP',
    reason: 'UNEXPECTED_STATUS',
    statusCode: 503,
    responseTimeMs: 5,
  });
}
