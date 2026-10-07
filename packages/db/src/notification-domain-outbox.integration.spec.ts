import { resolve } from 'node:path';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseWebhookNotification } from '@watchrail/contracts';
import { createMonitor, EMPTY_ASSERTION_EVALUATION } from '@watchrail/domain';
import {
  CheckExecutionRepository,
  type AuthoritativeCheckResult,
} from './check-execution-repository.js';
import { createDatabaseConnection, type DatabaseConnection } from './client.js';
import { ManualRoundRepository } from './manual-round-repository.js';
import { migrateDatabase } from './migration.js';
import { MonitorRepository } from './monitor-repository.js';
import { NotificationDeliveryRepository } from './notification-delivery-repository.js';
import { ScheduledRoundRepository } from './scheduled-round-repository.js';
import {
  checkExecutionAssignments,
  checkExecutionResults,
  checkRounds,
  incidents,
  monitorAvailabilityState,
  monitorIncidentState,
  monitors,
  notificationDeliveries,
  notificationEvents,
  webhookEndpointVersions,
} from './schema.js';
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

describe('notification domain outbox', () => {
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

  it('stages one event per transition and snapshots enabled immutable endpoint versions', async () => {
    const endpoints = new WebhookEndpointRepository(connection.db);
    const enabled = await endpoints.create(
      organizationId,
      { name: 'Operations', url: 'https://hooks.example.com/v1' },
      () => signingSecretEnvelope,
    );
    await endpoints.create(
      organizationId,
      { name: 'Disabled', url: 'https://disabled.example.com/v1', enabled: false },
      () => signingSecretEnvelope,
    );

    const first = await scheduledRound();
    await complete(first.id, unhealthy());
    await complete((await scheduledRound()).id, unhealthy());
    expect(await connection.db.select().from(notificationEvents)).toEqual([]);

    const openingRound = await scheduledRound();
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    await complete(openingRound.id, unhealthy());
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();

    const [openedEvent] = await connection.db.select().from(notificationEvents);
    const [openedDelivery] = await connection.db.select().from(notificationDeliveries);
    expect(parseWebhookNotification(openedEvent!.payload)).toMatchObject({
      contractVersion: 1,
      eventId: openedEvent!.id,
      eventType: 'INCIDENT_OPENED',
      organizationId,
      monitor: { id: monitorId, name: 'Payments API' },
      incident: { status: 'OPEN', startedAt: expect.any(String), openedAt: expect.any(String) },
      triggeringRoundId: openingRound.id,
    });
    expect(JSON.stringify(openedEvent!.payload)).not.toContain('hooks.example.com');
    expect(openedDelivery).toMatchObject({
      endpointId: enabled.id,
      attemptCount: 0,
    });

    await complete((await scheduledRound()).id, unhealthy());
    expect(await connection.db.select().from(notificationEvents)).toHaveLength(1);
    expect(await connection.db.select().from(notificationDeliveries)).toHaveLength(1);

    const secondVersion = await endpoints.updateSettings(
      organizationId,
      enabled.id,
      { name: enabled.name, url: 'https://hooks.example.com/v2', rotateSecret: true },
      () => ({ ...signingSecretEnvelope, keyId: 'test-v2' }),
    );
    const recoveryRound = await scheduledRound();
    await complete(recoveryRound.id, healthy());

    const events = await connection.db.select().from(notificationEvents);
    const deliveries = await connection.db.select().from(notificationDeliveries);
    const versions = await connection.db
      .select()
      .from(webhookEndpointVersions)
      .where(eq(webhookEndpointVersions.endpointId, enabled.id));
    const firstVersion = versions.find((version) => version.versionNumber === 1)!;
    const updatedVersion = versions.find((version) => version.versionNumber === 2)!;
    expect(events.map((event) => event.eventType).sort()).toEqual([
      'INCIDENT_OPENED',
      'INCIDENT_RESOLVED',
    ]);
    expect(deliveries).toHaveLength(2);
    expect(deliveries.find((value) => value.eventId === openedEvent!.id)?.endpointVersionId).toBe(
      firstVersion.id,
    );
    const resolvedEvent = events.find((event) => event.eventType === 'INCIDENT_RESOLVED')!;
    expect(deliveries.find((value) => value.eventId === resolvedEvent.id)?.endpointVersionId).toBe(
      updatedVersion.id,
    );
    expect(secondVersion.versionNumber).toBe(2);
    expect(parseWebhookNotification(resolvedEvent.payload)).toMatchObject({
      eventType: 'INCIDENT_RESOLVED',
      incident: { status: 'RESOLVED', resolvedAt: expect.any(String) },
      triggeringRoundId: recoveryRound.id,
    });
  });

  it('ignores manual and indeterminate observations and deduplicates concurrent threshold work', async () => {
    await createTestEndpoint(organizationId, 'Operations', 'https://hooks.example.com/events');
    const manual = await new ManualRoundRepository(connection.db).create(organizationId, monitorId);
    await complete(manual.id, unhealthy());
    await complete((await scheduledRound()).id, internalError());
    expect(await connection.db.select().from(notificationEvents)).toEqual([]);

    await complete((await scheduledRound()).id, unhealthy());
    await complete((await scheduledRound()).id, unhealthy());
    const third = await scheduledRound();
    const fourth = await scheduledRound();
    await Promise.all([complete(third.id, unhealthy()), complete(fourth.id, unhealthy())]);

    expect(await connection.db.select().from(incidents)).toHaveLength(1);
    expect(await connection.db.select().from(notificationEvents)).toHaveLength(1);
    expect(await connection.db.select().from(notificationDeliveries)).toHaveLength(1);
  });

  it('clamps non-monotonic observation clocks to chronological incident timestamps', async () => {
    await createTestEndpoint(organizationId, 'Operations', 'https://hooks.example.com/events');
    const startedAt = new Date('2026-10-06T12:10:00.000Z');
    await complete((await scheduledRound()).id, unhealthy(startedAt));
    await complete((await scheduledRound()).id, unhealthy(new Date('2026-10-06T12:11:00.000Z')));
    const openingRound = await scheduledRound();
    await complete(openingRound.id, unhealthy(new Date('2026-10-06T12:09:00.000Z')));

    const [opened] = await connection.db.select().from(incidents);
    const [openedEvent] = await connection.db.select().from(notificationEvents);
    expect(opened).toMatchObject({
      status: 'OPEN',
      startedAt,
      openedAt: startedAt,
      resolvedAt: null,
    });
    expect(parseWebhookNotification(openedEvent!.payload)).toMatchObject({
      eventType: 'INCIDENT_OPENED',
      occurredAt: startedAt.toISOString(),
      incident: {
        startedAt: startedAt.toISOString(),
        openedAt: startedAt.toISOString(),
        resolvedAt: null,
      },
    });

    const recoveryRound = await scheduledRound();
    await complete(recoveryRound.id, healthy(new Date('2026-10-06T12:08:00.000Z')));
    const [resolved] = await connection.db.select().from(incidents);
    const resolvedEvent = (await connection.db.select().from(notificationEvents)).find(
      (event) => event.eventType === 'INCIDENT_RESOLVED',
    );
    expect(resolved).toMatchObject({
      status: 'RESOLVED',
      startedAt,
      openedAt: startedAt,
      resolvedAt: startedAt,
    });
    expect(parseWebhookNotification(resolvedEvent!.payload)).toMatchObject({
      eventType: 'INCIDENT_RESOLVED',
      occurredAt: startedAt.toISOString(),
      incident: {
        startedAt: startedAt.toISOString(),
        openedAt: startedAt.toISOString(),
        resolvedAt: startedAt.toISOString(),
      },
    });
  });

  it('disabling affects future fan-out without cancelling an already-staged delivery', async () => {
    const repository = new WebhookEndpointRepository(connection.db);
    const endpoint = await repository.create(
      organizationId,
      { name: 'Operations', url: 'https://hooks.example.com/events' },
      () => signingSecretEnvelope,
    );
    await openIncident();
    const [openedDelivery] = await connection.db.select().from(notificationDeliveries);
    expect(openedDelivery?.endpointId).toBe(endpoint.id);

    await repository.setEnabled(organizationId, endpoint.id, false);
    await complete((await scheduledRound()).id, healthy());

    expect(await connection.db.select().from(notificationEvents)).toHaveLength(2);
    const deliveries = await connection.db.select().from(notificationDeliveries);
    expect(deliveries).toEqual([openedDelivery]);
  });

  it('claims with skip-locked leases and guards every terminal mutation by token', async () => {
    await createTestEndpoint(organizationId, 'Operations', 'https://hooks.example.com/events');
    await openIncident();
    const repository = new NotificationDeliveryRepository(connection.db);

    const claims = await Promise.all([repository.claimNext(), repository.claimNext()]);
    const first = claims.find((claim) => claim !== null)!;
    expect(claims.filter((claim) => claim !== null)).toHaveLength(1);
    expect(first).toMatchObject({
      attemptCount: 1,
      url: 'https://hooks.example.com/events',
      payload: { eventType: 'INCIDENT_OPENED' },
      signingSecretEnvelope,
    });

    await connection.db.execute(
      sql`update notification_deliveries set available_at=clock_timestamp() - interval '1 second' where id=${first.id}::uuid`,
    );
    const second = await repository.claimNext();
    expect(second).toMatchObject({ id: first.id, attemptCount: 2 });
    expect(second!.claimToken).not.toBe(first.claimToken);
    await expect(repository.acknowledgeDelivered(first.id, first.claimToken, 200)).resolves.toBe(
      false,
    );
    await expect(
      repository.releaseForRetry(first.id, first.claimToken, 1000, 'STALE'),
    ).resolves.toBe(false);
    await expect(repository.markDead(first.id, first.claimToken, 'STALE', 'STALE')).resolves.toBe(
      false,
    );
    await expect(
      repository.releaseForRetry(first.id, second!.claimToken, 1000, 'HTTP_503', 503),
    ).resolves.toBe(true);
    await connection.db.execute(
      sql`update notification_deliveries set available_at=clock_timestamp() - interval '1 second' where id=${first.id}::uuid`,
    );
    const third = await repository.claimNext();
    await expect(
      repository.markDead(first.id, third!.claimToken, 'MAX_ATTEMPTS', 'HTTP_503', 503),
    ).resolves.toBe(true);
    const [dead] = await connection.db
      .select()
      .from(notificationDeliveries)
      .where(eq(notificationDeliveries.id, first.id));
    expect(dead).toMatchObject({
      deadReason: 'MAX_ATTEMPTS',
      lastErrorCode: 'HTTP_503',
      lastHttpStatus: 503,
    });
    await expect(repository.claimNext()).resolves.toBeNull();

    await complete((await scheduledRound()).id, healthy());
    const resolved = await repository.claimNext();
    expect(parseWebhookNotification(resolved!.payload).eventType).toBe('INCIDENT_RESOLVED');
    await expect(
      repository.acknowledgeDelivered(resolved!.id, resolved!.claimToken, 204),
    ).resolves.toBe(true);
    await expect(repository.claimNext()).resolves.toBeNull();
  });

  it('lets concurrent claimers take distinct due deliveries without blocking', async () => {
    await createTestEndpoint(
      organizationId,
      'Primary operations',
      'https://primary.example.com/events',
    );
    await createTestEndpoint(
      organizationId,
      'Secondary operations',
      'https://secondary.example.com/events',
    );
    await openIncident();

    const repository = new NotificationDeliveryRepository(connection.db);
    const claims = await Promise.all([repository.claimNext(), repository.claimNext()]);

    expect(claims.every((claim) => claim !== null)).toBe(true);
    expect(new Set(claims.map((claim) => claim!.id)).size).toBe(2);
  });

  it('claims malformed durable payloads raw so the worker can dead-letter them', async () => {
    await createTestEndpoint(organizationId, 'Operations', 'https://hooks.example.com/events');
    await openIncident();
    const [event] = await connection.db.select().from(notificationEvents);
    const malformed = { ...(event!.payload as object), poison: true };
    await connection.db.execute(
      sql`update notification_events set payload=${JSON.stringify(malformed)}::jsonb where id=${event!.id}::uuid`,
    );
    const claimed = await new NotificationDeliveryRepository(connection.db).claimNext();
    expect(claimed).toMatchObject({
      eventId: event!.id,
      organizationId,
      endpointVersionNumber: 1,
      payload: { contractVersion: 1, poison: true },
    });
  });

  it.each(['notification_events', 'notification_deliveries'])(
    'rolls back completion, incident state, and durable notification staging when %s fails',
    async (table) => {
      await createTestEndpoint(organizationId, 'Operations', 'https://hooks.example.com/events');
      await complete((await scheduledRound()).id, unhealthy());
      await complete((await scheduledRound()).id, unhealthy());
      const third = await scheduledRound();
      const executions = new CheckExecutionRepository(connection.db);
      const claim = await executions.claim(third.id, 45_000);
      if (claim.state !== 'CLAIMED') throw new Error('Expected claim.');
      const [availabilityBefore] = await connection.db
        .select()
        .from(monitorAvailabilityState)
        .where(eq(monitorAvailabilityState.monitorId, monitorId));
      await connection.pool.query(`
        create function watchrail_test_fail_notification() returns trigger language plpgsql as $$
        begin
          raise exception 'forced notification failure';
        end;
        $$;
        create trigger watchrail_test_fail_notification before insert on ${table}
        for each row execute function watchrail_test_fail_notification();
      `);
      try {
        await expect(
          executions.complete(
            claim.execution.assignmentId,
            claim.execution.claimToken,
            unhealthy(),
          ),
        ).rejects.toThrow();
      } finally {
        await connection.pool.query(`
          drop trigger watchrail_test_fail_notification on ${table};
          drop function watchrail_test_fail_notification();
        `);
      }

      const [state] = await connection.db
        .select()
        .from(monitorIncidentState)
        .where(eq(monitorIncidentState.monitorId, monitorId));
      const [assignment] = await connection.db
        .select()
        .from(checkExecutionAssignments)
        .where(eq(checkExecutionAssignments.roundId, third.id));
      const [round] = await connection.db
        .select()
        .from(checkRounds)
        .where(eq(checkRounds.id, third.id));
      expect(state?.consecutiveFailures).toBe(2);
      const [availabilityAfter] = await connection.db
        .select()
        .from(monitorAvailabilityState)
        .where(eq(monitorAvailabilityState.monitorId, monitorId));
      expect(availabilityAfter).toEqual(availabilityBefore);
      expect(await connection.db.select().from(incidents)).toEqual([]);
      expect(await connection.db.select().from(notificationEvents)).toEqual([]);
      expect(await connection.db.select().from(notificationDeliveries)).toEqual([]);
      expect(
        await connection.db
          .select()
          .from(checkExecutionResults)
          .where(eq(checkExecutionResults.roundId, third.id)),
      ).toEqual([]);
      expect(assignment?.status).toBe('RUNNING');
      expect(round?.status).toBe('PENDING');
    },
  );

  it('enforces tenant-safe endpoint-version delivery references', async () => {
    const foreignOrganizationId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const local = await createTestEndpoint(
      organizationId,
      'Local',
      'https://local.example.com/events',
    );
    const foreign = await createTestEndpoint(
      foreignOrganizationId,
      'Foreign',
      'https://foreign.example.com/events',
    );
    await openIncident();
    const [event] = await connection.db.select().from(notificationEvents);
    const [foreignVersion] = await connection.db
      .select()
      .from(webhookEndpointVersions)
      .where(eq(webhookEndpointVersions.endpointId, foreign.id));

    await expect(
      connection.db.insert(notificationDeliveries).values({
        organizationId,
        eventId: event!.id,
        endpointId: foreign.id,
        endpointVersionId: foreignVersion!.id,
      }),
    ).rejects.toThrow();
    expect(local.organizationId).toBe(organizationId);
  });

  function createTestEndpoint(tenantId: string, name: string, url: string) {
    return new WebhookEndpointRepository(connection.db).create(
      tenantId,
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

function healthy(checkedAt = new Date()) {
  return result({
    outcome: 'PASS',
    stage: 'HTTP',
    reason: 'COMPLETED',
    statusCode: 200,
    responseTimeMs: 5,
    checkedAt,
  });
}

function unhealthy(checkedAt = new Date()) {
  return result({
    outcome: 'FAIL',
    stage: 'HTTP',
    reason: 'UNEXPECTED_STATUS',
    statusCode: 503,
    responseTimeMs: 5,
    checkedAt,
  });
}

function internalError() {
  return result({ outcome: 'UNKNOWN', stage: 'PROBE', reason: 'INTERNAL_ERROR' });
}
