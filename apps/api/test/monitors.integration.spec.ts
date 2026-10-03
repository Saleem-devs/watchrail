import 'reflect-metadata';
import { resolve } from 'node:path';
import { Logger, type INestApplication } from '@nestjs/common';
import { getDrizzleToken } from '@nestjs/drizzle';
import { Test } from '@nestjs/testing';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { CheckExecutionRepository, createDatabaseConnection, migrateDatabase } from '@watchrail/db';
import type { WatchrailDatabase } from '@watchrail/db';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppModule } from '../src/app.module.js';

describe('monitor API', () => {
  let app: INestApplication;
  let container: StartedPostgreSqlContainer;
  let database: WatchrailDatabase;

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

    const migrationConnection = createDatabaseConnection(container.getConnectionUri());
    await migrateDatabase(migrationConnection, resolve(process.cwd(), '../../packages/db/drizzle'));
    await migrationConnection.pool.end();

    const testingModule = await Test.createTestingModule({ imports: [AppModule] }).compile();
    database = testingModule.get<WatchrailDatabase>(getDrizzleToken());
    app = testingModule.createNestApplication();
    app.setGlobalPrefix('api');
    await app.init();
  }, 60_000);

  beforeEach(async () => {
    const connection = createDatabaseConnection(container.getConnectionUri());
    await connection.pool.query(`
      truncate table
        check_execution_results,
        check_round_outbox,
        check_execution_assignments,
        check_rounds,
        monitor_configuration_versions,
        monitors
      cascade
    `);
    await connection.pool.end();
  });

  afterAll(async () => {
    await app?.close();
    await expect(database.$client.query('select 1')).rejects.toThrow(
      'Cannot use a pool after calling end on the pool',
    );
    await container?.stop();
  });

  it('creates and lists a monitor with server-owned defaults', async () => {
    const created = await request(app.getHttpServer())
      .post('/api/monitors')
      .send({
        name: 'Public API',
        url: 'https://example.com/health',
        method: 'DELETE',
        lifecycleState: 'ARCHIVED',
      })
      .expect(201);

    expect(created.body.data).toMatchObject({
      name: 'Public API',
      url: 'https://example.com/health',
      method: 'GET',
      lifecycleState: 'ENABLED',
      timeoutMs: 10_000,
      intervalSeconds: 60,
      followRedirects: true,
      statusPolicy: { type: 'ANY_2XX' },
      locations: ['local'],
      incidentState: { failureStreak: null, currentIncident: null },
    });

    const listed = await request(app.getHttpServer()).get('/api/monitors').expect(200);
    expect(listed.body.data).toHaveLength(1);
    expect(listed.body.data[0].id).toBe(created.body.data.id);
  });

  it('versions interval settings and enforces lifecycle scheduling invariants', async () => {
    const beforeCreate = Date.now();
    const created = await request(app.getHttpServer())
      .post('/api/monitors')
      .send({
        name: 'Scheduled API',
        url: 'https://example.com/health',
        intervalSeconds: 300,
      })
      .expect(201);
    const monitorId = created.body.data.id as string;
    const originalNextCheckAt = created.body.data.nextCheckAt as string;
    expect(created.body.data.intervalSeconds).toBe(300);
    expect(Date.parse(originalNextCheckAt)).toBeGreaterThanOrEqual(beforeCreate + 299_000);

    const unchanged = await request(app.getHttpServer())
      .patch(`/api/monitors/${monitorId}/schedule-settings`)
      .send({ intervalSeconds: 300 })
      .expect(200);
    expect(unchanged.body.data.nextCheckAt).toBe(originalNextCheckAt);

    const changed = await request(app.getHttpServer())
      .patch(`/api/monitors/${monitorId}/schedule-settings`)
      .send({ intervalSeconds: 600 })
      .expect(200);
    expect(changed.body.data.intervalSeconds).toBe(600);
    expect(Date.parse(changed.body.data.nextCheckAt as string)).toBeGreaterThan(
      Date.parse(originalNextCheckAt),
    );

    const versions = await database.$client.query<{
      version_number: number;
      interval_seconds: number;
    }>(
      `select version_number, interval_seconds
       from monitor_configuration_versions
       where monitor_id = $1
       order by version_number`,
      [monitorId],
    );
    expect(versions.rows).toEqual([
      { version_number: 1, interval_seconds: 300 },
      { version_number: 2, interval_seconds: 600 },
    ]);

    const paused = await request(app.getHttpServer())
      .patch(`/api/monitors/${monitorId}/lifecycle`)
      .send({ lifecycleState: 'PAUSED' })
      .expect(200);
    expect(paused.body.data).toMatchObject({ lifecycleState: 'PAUSED', nextCheckAt: null });

    const pausedSchedule = await request(app.getHttpServer())
      .patch(`/api/monitors/${monitorId}/schedule-settings`)
      .send({ intervalSeconds: 900 })
      .expect(200);
    expect(pausedSchedule.body.data).toMatchObject({
      lifecycleState: 'PAUSED',
      intervalSeconds: 900,
      nextCheckAt: null,
    });

    const enabled = await request(app.getHttpServer())
      .patch(`/api/monitors/${monitorId}/lifecycle`)
      .send({ lifecycleState: 'ENABLED' })
      .expect(200);
    expect(enabled.body.data.lifecycleState).toBe('ENABLED');
    expect(enabled.body.data.nextCheckAt).toEqual(expect.any(String));

    const unchangedEnabled = await request(app.getHttpServer())
      .patch(`/api/monitors/${monitorId}/lifecycle`)
      .send({ lifecycleState: 'ENABLED' })
      .expect(200);
    expect(unchangedEnabled.body.data.nextCheckAt).toBe(enabled.body.data.nextCheckAt);

    const nextBeforeManual = enabled.body.data.nextCheckAt as string;
    await request(app.getHttpServer()).post(`/api/monitors/${monitorId}/check-rounds`).expect(202);
    const [afterManual] = (
      await database.$client.query<{ next_check_at: Date }>(
        'select next_check_at from monitors where id = $1',
        [monitorId],
      )
    ).rows;
    expect(afterManual?.next_check_at.toISOString()).toBe(nextBeforeManual);

    const archived = await request(app.getHttpServer())
      .patch(`/api/monitors/${monitorId}/lifecycle`)
      .send({ lifecycleState: 'ARCHIVED' })
      .expect(200);
    expect(archived.body.data).toMatchObject({ lifecycleState: 'ARCHIVED', nextCheckAt: null });
    const listed = await request(app.getHttpServer()).get('/api/monitors').expect(200);
    expect(listed.body.data).toEqual([]);
    await request(app.getHttpServer())
      .patch(`/api/monitors/${monitorId}/lifecycle`)
      .send({ lifecycleState: 'ENABLED' })
      .expect(409);
  });

  it.each([
    {},
    { intervalSeconds: '60' },
    { intervalSeconds: 59 },
    { intervalSeconds: 86_401 },
    { intervalSeconds: 60.5 },
    { intervalSeconds: 60, nextCheckAt: null },
  ])('rejects invalid schedule settings %#', async (body) => {
    const created = await request(app.getHttpServer())
      .post('/api/monitors')
      .send({ name: 'Schedule validation', url: 'https://example.com' })
      .expect(201);
    await request(app.getHttpServer())
      .patch(`/api/monitors/${created.body.data.id as string}/schedule-settings`)
      .send(body)
      .expect(400);
  });

  it('preserves interval settings through every unrelated configuration writer', async () => {
    const created = await request(app.getHttpServer())
      .post('/api/monitors')
      .send({ name: 'Immutable schedule', url: 'https://example.com', intervalSeconds: 300 })
      .expect(201);
    const monitorId = created.body.data.id as string;

    await request(app.getHttpServer())
      .patch(`/api/monitors/${monitorId}/status-policy`)
      .send({ statusPolicy: { type: 'EXACT', statusCodes: [204] } })
      .expect(200);
    await request(app.getHttpServer())
      .patch(`/api/monitors/${monitorId}/request-headers`)
      .send({ requestHeaders: [{ name: 'x-watchrail', sensitive: false, value: 'test' }] })
      .expect(200);
    await request(app.getHttpServer())
      .patch(`/api/monitors/${monitorId}/http-settings`)
      .send({
        url: 'https://status.example.com',
        method: 'GET',
        timeoutMs: 5_000,
        followRedirects: false,
      })
      .expect(200);
    await request(app.getHttpServer())
      .patch(`/api/monitors/${monitorId}/assertions`)
      .send({
        headers: [{ name: 'content-type', operator: 'exists' }],
        textBody: [],
        jsonBody: [],
      })
      .expect(200);

    const versions = await database.$client.query<{
      version_number: number;
      interval_seconds: number;
    }>(
      `select version_number, interval_seconds
       from monitor_configuration_versions
       where monitor_id = $1
       order by version_number`,
      [monitorId],
    );
    expect(versions.rows).toEqual(
      [1, 2, 3, 4, 5].map((version_number) => ({
        version_number,
        interval_seconds: 300,
      })),
    );
  });

  it('normalizes and versions exact status-policy edits', async () => {
    const created = await request(app.getHttpServer())
      .post('/api/monitors')
      .send({
        name: 'Expected maintenance response',
        url: 'https://example.com/health',
        statusPolicy: { type: 'EXACT', statusCodes: [404, 200, 404] },
      })
      .expect(201);

    expect(created.body.data.statusPolicy).toEqual({
      type: 'EXACT',
      statusCodes: [200, 404],
    });

    const monitorId = created.body.data.id as string;
    const updated = await request(app.getHttpServer())
      .patch(`/api/monitors/${monitorId}/status-policy`)
      .send({ statusPolicy: { type: 'EXACT', statusCodes: [204] } })
      .expect(200);

    expect(updated.body.data.statusPolicy).toEqual({ type: 'EXACT', statusCodes: [204] });

    const versions = await database.$client.query<{
      version_number: number;
      status_policy: unknown;
    }>(
      `select version_number, status_policy
       from monitor_configuration_versions
       where monitor_id = $1
       order by version_number`,
      [monitorId],
    );

    expect(versions.rows).toEqual([
      { version_number: 1, status_policy: { type: 'EXACT', statusCodes: [200, 404] } },
      { version_number: 2, status_policy: { type: 'EXACT', statusCodes: [204] } },
    ]);
  });

  it('versions complete HTTP settings while old rounds retain captured settings', async () => {
    const created = await request(app.getHttpServer())
      .post('/api/monitors')
      .send({
        name: 'Versioned API',
        url: 'https://old.example.com/health',
        statusPolicy: { type: 'EXACT', statusCodes: [204] },
        requestHeaders: [{ name: 'x-watchrail-test', sensitive: false, value: 'preserved' }],
      })
      .expect(201);
    const monitorId = created.body.data.id as string;
    const oldRound = await request(app.getHttpServer())
      .post(`/api/monitors/${monitorId}/check-rounds`)
      .expect(202);

    const settings = {
      url: 'https://new.example.com/ready',
      method: 'HEAD',
      timeoutMs: 5_000,
      followRedirects: false,
    } as const;
    const updated = await request(app.getHttpServer())
      .patch(`/api/monitors/${monitorId}/http-settings`)
      .send(settings)
      .expect(200);

    expect(updated.body.data).toMatchObject(settings);

    const versions = await database.$client.query<{
      version_number: number;
      url: string;
      method: string;
      timeout_ms: number;
      follow_redirects: boolean;
      status_policy: unknown;
      request_headers: unknown;
      locations: unknown;
    }>(
      `select version_number, url, method, timeout_ms, follow_redirects,
              status_policy, request_headers, locations
       from monitor_configuration_versions
       where monitor_id = $1
       order by version_number`,
      [monitorId],
    );

    expect(versions.rows).toHaveLength(2);
    expect(versions.rows[0]).toMatchObject({
      version_number: 1,
      url: 'https://old.example.com/health',
      method: 'GET',
      timeout_ms: 10_000,
      follow_redirects: true,
      status_policy: { type: 'EXACT', statusCodes: [204] },
      locations: ['local'],
    });
    expect(versions.rows[1]).toMatchObject({
      version_number: 2,
      url: settings.url,
      method: settings.method,
      timeout_ms: settings.timeoutMs,
      follow_redirects: false,
      status_policy: versions.rows[0]!.status_policy,
      request_headers: versions.rows[0]!.request_headers,
      locations: versions.rows[0]!.locations,
    });

    const executions = new CheckExecutionRepository(database);
    const oldClaim = await executions.claim(oldRound.body.data.id as string, 30_000);
    expect(oldClaim).toMatchObject({
      state: 'CLAIMED',
      execution: {
        url: 'https://old.example.com/health',
        method: 'GET',
        timeoutMs: 10_000,
        followRedirects: true,
      },
    });

    const newRound = await request(app.getHttpServer())
      .post(`/api/monitors/${monitorId}/check-rounds`)
      .expect(202);
    const newClaim = await executions.claim(newRound.body.data.id as string, 30_000);
    expect(newClaim).toMatchObject({ state: 'CLAIMED', execution: settings });
  });

  it.each([
    [{ url: 'https://example.com', method: 'POST', timeoutMs: 5_000, followRedirects: true }],
    [{ url: 'https://example.com', method: 'GET', timeoutMs: 999, followRedirects: true }],
    [{ url: 'https://example.com', method: 'GET', timeoutMs: 30_001, followRedirects: true }],
    [{ url: 'https://example.com', method: 'GET', timeoutMs: 5_000, followRedirects: 'false' }],
    [{ url: 'https://example.com', method: 'GET', timeoutMs: 5_000 }],
  ])('rejects invalid or incomplete HTTP settings %#', async (settings) => {
    const created = await request(app.getHttpServer())
      .post('/api/monitors')
      .send({ name: 'Validation target', url: 'https://example.com' })
      .expect(201);

    await request(app.getHttpServer())
      .patch(`/api/monitors/${created.body.data.id as string}/http-settings`)
      .send(settings)
      .expect(400)
      .expect(({ body }) => expect(body).toMatchObject({ code: 'VALIDATION_FAILED' }));
  });

  it('encrypts sensitive headers, redacts reads, and retains secrets explicitly', async () => {
    const created = await request(app.getHttpServer())
      .post('/api/monitors')
      .send({
        name: 'Authenticated API',
        url: 'https://example.com/health',
        requestHeaders: [
          { name: 'Authorization', sensitive: false, value: 'Bearer top-secret' },
          { name: 'X-Environment', sensitive: false, value: 'production' },
        ],
      })
      .expect(201);

    expect(created.body.data.requestHeaders).toEqual([
      { name: 'authorization', sensitive: true, value: null, hasValue: true },
      { name: 'x-environment', sensitive: false, value: 'production', hasValue: true },
    ]);

    const monitorId = created.body.data.id as string;
    const stored = await database.$client.query<{ request_headers: unknown }>(
      'select request_headers from monitors where id = $1',
      [monitorId],
    );
    expect(JSON.stringify(stored.rows[0]?.request_headers)).not.toContain('top-secret');

    const updated = await request(app.getHttpServer())
      .patch(`/api/monitors/${monitorId}/request-headers`)
      .send({
        requestHeaders: [
          { name: 'Authorization', sensitive: true, retain: true },
          { name: 'X-Environment', sensitive: false, value: 'staging' },
        ],
      })
      .expect(200);

    expect(updated.body.data.requestHeaders).toEqual([
      { name: 'authorization', sensitive: true, value: null, hasValue: true },
      { name: 'x-environment', sensitive: false, value: 'staging', hasValue: true },
    ]);

    const versions = await database.$client.query<{ request_headers: unknown }>(
      `select request_headers
       from monitor_configuration_versions
       where monitor_id = $1
       order by version_number`,
      [monitorId],
    );
    expect(versions.rows).toHaveLength(2);
    expect(JSON.stringify(versions.rows)).not.toContain('top-secret');
  });

  it('rejects unsafe headers and retaining a missing secret', async () => {
    await request(app.getHttpServer())
      .post('/api/monitors')
      .send({
        name: 'Unsafe headers',
        url: 'https://example.com',
        requestHeaders: [{ name: 'Host', sensitive: false, value: 'internal.example' }],
      })
      .expect(400);

    const created = await request(app.getHttpServer())
      .post('/api/monitors')
      .send({ name: 'API', url: 'https://example.com' })
      .expect(201);

    await request(app.getHttpServer())
      .patch(`/api/monitors/${String(created.body.data.id)}/request-headers`)
      .send({ requestHeaders: [{ name: 'Authorization', sensitive: true, retain: true }] })
      .expect(400);
  });

  it('encrypts, redacts, retains, and immutably snapshots response assertions', async () => {
    const sentinel = 'WATCHRAIL_ASSERTION_SENTINEL_SECRET';
    const created = await request(app.getHttpServer())
      .post('/api/monitors')
      .send({ name: 'Assertion target', url: 'https://example.com' })
      .expect(201);
    const monitorId = created.body.data.id as string;
    expect(created.body.data.assertions).toEqual({
      contractVersion: 1,
      assertions: { headers: [], textBody: [], jsonBody: [] },
    });

    const configured = await request(app.getHttpServer())
      .patch(`/api/monitors/${monitorId}/assertions`)
      .send({
        headers: [
          {
            name: 'x-state',
            operator: 'equals',
            target: { sensitive: false, value: 'ready' },
          },
        ],
        textBody: [],
        jsonBody: [
          {
            selector: '$.token',
            operator: 'equals',
            target: {
              sensitive: true,
              value: { type: 'string', value: sentinel },
            },
          },
        ],
      })
      .expect(200);

    expect(configured.body.data.assertions).toMatchObject({
      assertions: {
        headers: [{ target: { sensitive: false, value: 'ready' } }],
        jsonBody: [{ target: { sensitive: true, hasValue: true } }],
      },
    });
    expect(JSON.stringify(configured.body)).not.toContain(sentinel);
    expect(JSON.stringify(configured.body)).not.toContain('ciphertext');

    const oldRound = await request(app.getHttpServer())
      .post(`/api/monitors/${monitorId}/check-rounds`)
      .expect(202);

    await request(app.getHttpServer())
      .patch(`/api/monitors/${monitorId}/assertions`)
      .send({
        headers: [],
        textBody: [],
        jsonBody: [
          {
            selector: '$.token',
            operator: 'equals',
            target: { sensitive: true, retain: true },
          },
        ],
      })
      .expect(200);

    const stored = await database.$client.query<{ assertions: unknown }>(
      `select assertions from monitor_configuration_versions
       where monitor_id = $1 order by version_number`,
      [monitorId],
    );
    expect(stored.rows).toHaveLength(3);
    expect(JSON.stringify(stored.rows)).not.toContain(sentinel);
    const versionTwo = stored.rows[1]?.assertions as {
      assertions: { jsonBody: Array<{ target?: unknown }> };
    };
    const versionThree = stored.rows[2]?.assertions as {
      assertions: { jsonBody: Array<{ target?: unknown }> };
    };
    expect(versionThree.assertions.jsonBody[0]?.target).toEqual(
      versionTwo.assertions.jsonBody[0]?.target,
    );

    const claim = await new CheckExecutionRepository(database).claim(
      oldRound.body.data.id as string,
      30_000,
    );
    expect(claim.state).toBe('CLAIMED');
    if (claim.state !== 'CLAIMED') throw new Error('Expected old round claim.');
    expect(claim.execution.assertions).toEqual(stored.rows[1]?.assertions);
  });

  it('enforces HEAD and body-assertion compatibility in both update directions', async () => {
    const created = await request(app.getHttpServer())
      .post('/api/monitors')
      .send({ name: 'Compatibility target', url: 'https://example.com' })
      .expect(201);
    const monitorId = created.body.data.id as string;

    await request(app.getHttpServer())
      .patch(`/api/monitors/${monitorId}/assertions`)
      .send({
        headers: [],
        textBody: [{ operator: 'contains', target: { sensitive: false, value: 'ready' } }],
        jsonBody: [],
      })
      .expect(200);
    await request(app.getHttpServer())
      .patch(`/api/monitors/${monitorId}/http-settings`)
      .send({
        url: 'https://example.com',
        method: 'HEAD',
        timeoutMs: 10_000,
        followRedirects: true,
      })
      .expect(400);

    const head = await request(app.getHttpServer())
      .post('/api/monitors')
      .send({ name: 'HEAD target', url: 'https://example.com' })
      .expect(201);
    await request(app.getHttpServer())
      .patch(`/api/monitors/${head.body.data.id as string}/http-settings`)
      .send({
        url: 'https://example.com',
        method: 'HEAD',
        timeoutMs: 10_000,
        followRedirects: true,
      })
      .expect(200);
    await request(app.getHttpServer())
      .patch(`/api/monitors/${head.body.data.id as string}/assertions`)
      .send({
        headers: [],
        textBody: [{ operator: 'contains', target: { sensitive: false, value: 'ready' } }],
        jsonBody: [],
      })
      .expect(400);
  });

  it('does not expose a sentinel from corrupted stored headers in API errors', async () => {
    const sentinel = 'WATCHRAIL_SENTINEL_SECRET';
    const logger = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const created = await request(app.getHttpServer())
      .post('/api/monitors')
      .send({ name: 'Corrupted configuration', url: 'https://example.com' })
      .expect(201);

    await database.$client.query('update monitors set request_headers = $1::jsonb where id = $2', [
      JSON.stringify([{ name: 'authorization', sensitive: true, encryptedValue: sentinel }]),
      created.body.data.id,
    ]);

    const response = await request(app.getHttpServer()).get('/api/monitors').expect(500);
    expect(JSON.stringify(response.body)).not.toContain(sentinel);
    expect(JSON.stringify(logger.mock.calls)).not.toContain(sentinel);
    logger.mockRestore();
  });

  it('rejects an invalid exact status policy', async () => {
    const invalid = await request(app.getHttpServer())
      .post('/api/monitors')
      .send({
        name: 'API',
        url: 'https://example.com',
        statusPolicy: { type: 'EXACT', statusCodes: [] },
      })
      .expect(400);

    expect(invalid.body.fields.statusPolicy).toEqual([
      'Enter one or more integer status codes from 100 to 599.',
    ]);
  });

  it('returns field-level errors and does not create a partial record', async () => {
    const invalid = await request(app.getHttpServer())
      .post('/api/monitors')
      .send({ name: ' ', url: 'ftp://example.com' })
      .expect(400);

    expect(invalid.body).toMatchObject({
      code: 'VALIDATION_FAILED',
      fields: {
        name: ['Enter a monitor name.'],
        url: ['Use an HTTP or HTTPS URL.'],
      },
    });

    const listed = await request(app.getHttpServer()).get('/api/monitors').expect(200);
    expect(listed.body.data).toEqual([]);
  });

  it('starts a durable manual round and returns its eventual result', async () => {
    const createdMonitor = await request(app.getHttpServer())
      .post('/api/monitors')
      .send({ name: 'Public API', url: 'https://example.com/health' })
      .expect(201);

    const monitorId = createdMonitor.body.data.id as string;
    const accepted = await request(app.getHttpServer())
      .post(`/api/monitors/${monitorId}/check-rounds`)
      .expect(202);

    expect(accepted.body.data).toMatchObject({
      monitorId,
      trigger: 'MANUAL',
      status: 'PENDING',
      assignmentStatus: 'PENDING',
      result: null,
    });

    const roundId = accepted.body.data.id as string;
    const pending = await request(app.getHttpServer())
      .get(`/api/monitors/${monitorId}/check-rounds/${roundId}`)
      .expect(200);

    expect(pending.body.data).toMatchObject({
      id: roundId,
      trigger: 'MANUAL',
      status: 'PENDING',
      assignmentStatus: 'PENDING',
      result: null,
    });

    const executions = new CheckExecutionRepository(database);
    const claim = await executions.claim(roundId, 30_000);
    expect(claim.state).toBe('CLAIMED');
    if (claim.state !== 'CLAIMED') throw new Error('Expected the round to be claimable.');

    const checkedAt = new Date('2026-09-24T12:00:00.000Z');
    const redirects = [
      {
        sequence: 1,
        statusCode: 302 as const,
        source: { targetId: 1, origin: 'https://example.com:443' },
        destination: { targetId: 2, origin: 'https://status.example:443' },
        responseTimeMs: 12.25,
        headers: 'STRIPPED' as const,
      },
    ];
    const assertionEvaluation = {
      contractVersion: 1 as const,
      outcome: 'FAIL' as const,
      diagnostics: [
        {
          index: 0,
          source: 'JSON_BODY' as const,
          subject: '$.status',
          operator: 'equals' as const,
          outcome: 'FAIL' as const,
          reason: 'JSON_BODY_MISMATCH' as const,
        },
      ],
    };
    await executions.complete(claim.execution.assignmentId, claim.execution.claimToken, {
      outcome: 'PASS',
      stage: 'HTTP',
      reason: 'COMPLETED',
      statusCode: 200,
      responseTimeMs: 42.5,
      attemptDurationMs: 46.25,
      checkedAt,
      redirects,
      assertionEvaluation,
    });

    const completed = await request(app.getHttpServer())
      .get(`/api/monitors/${monitorId}/check-rounds/${roundId}`)
      .expect(200);

    expect(completed.body.data).toEqual({
      id: roundId,
      monitorId,
      trigger: 'MANUAL',
      status: 'COMPLETED',
      assignmentStatus: 'COMPLETED',
      createdAt: accepted.body.data.createdAt,
      result: {
        outcome: 'PASS',
        stage: 'HTTP',
        reason: 'COMPLETED',
        statusCode: 200,
        responseTimeMs: 42.5,
        attemptDurationMs: 46.25,
        redirects,
        assertionEvaluation,
        checkedAt: checkedAt.toISOString(),
      },
    });
    expect(JSON.stringify(completed.body.data.result)).not.toContain('/health');

    const history = await request(app.getHttpServer())
      .get(`/api/monitors/${monitorId}/check-rounds?limit=1&trigger=MANUAL`)
      .expect(200);
    expect(history.body).toMatchObject({
      data: [
        {
          id: roundId,
          trigger: 'MANUAL',
          result: { outcome: 'PASS', assertionOutcome: 'FAIL' },
        },
      ],
      page: { nextCursor: null },
    });
    expect(history.body.data[0].result).not.toHaveProperty('redirects');
    expect(history.body.data[0].result).not.toHaveProperty('assertionEvaluation');

    const listed = await request(app.getHttpServer()).get('/api/monitors').expect(200);
    expect(listed.body.data[0].currentCheck).toMatchObject({
      availability: 'AVAILABLE',
      responseTimeMs: 42.5,
      roundId,
      trigger: 'MANUAL',
    });

    const updated = await request(app.getHttpServer())
      .patch(`/api/monitors/${monitorId}/status-policy`)
      .send({ statusPolicy: { type: 'EXACT', statusCodes: [200] } })
      .expect(200);
    expect(updated.body.data.currentCheck).toEqual(listed.body.data[0].currentCheck);
    expect(updated.body.data.incidentState).toEqual({
      failureStreak: null,
      currentIncident: null,
    });

    const incidentId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    await database.$client.query(
      `update monitor_incident_state
       set consecutive_failures = 3,
           failure_streak_started_at = $1,
           failure_streak_started_round_id = $2
       where monitor_id = $3`,
      [checkedAt, roundId, monitorId],
    );
    await database.$client.query(
      `insert into incidents (
         id, organization_id, monitor_id, status, started_at, opened_at,
         started_by_round_id, opened_by_round_id
       ) values ($1, $2, $3, 'OPEN', $4, $4, $5, $5)`,
      [incidentId, '00000000-0000-4000-8000-000000000002', monitorId, checkedAt, roundId],
    );
    const incidentList = await request(app.getHttpServer())
      .get(`/api/monitors/${monitorId}/incidents?limit=1`)
      .expect(200);
    expect(incidentList.body).toMatchObject({
      data: [{ id: incidentId, status: 'OPEN', resolvedAt: null }],
      page: { nextCursor: null },
    });
    const incidentDetail = await request(app.getHttpServer())
      .get(`/api/monitors/${monitorId}/incidents/${incidentId}`)
      .expect(200);
    expect(incidentDetail.body.data).toMatchObject({
      id: incidentId,
      monitorId,
      startedByRoundId: roundId,
      openedByRoundId: roundId,
      resolvedByRoundId: null,
    });
    const withIncident = await request(app.getHttpServer()).get('/api/monitors').expect(200);
    expect(withIncident.body.data[0].incidentState).toMatchObject({
      failureStreak: { count: 3, threshold: 3 },
      currentIncident: { id: incidentId, status: 'OPEN' },
    });
  });

  it('rejects invalid history queries and isolates monitor history', async () => {
    const created = await request(app.getHttpServer())
      .post('/api/monitors')
      .send({ name: 'History API', url: 'https://example.com' })
      .expect(201);
    const monitorId = created.body.data.id as string;

    await request(app.getHttpServer())
      .get(`/api/monitors/${monitorId}/check-rounds?limit=0`)
      .expect(400)
      .expect(({ body }) => expect(body).toMatchObject({ code: 'INVALID_HISTORY_QUERY' }));
    await request(app.getHttpServer())
      .get(`/api/monitors/${monitorId}/check-rounds?cursor=not-a-cursor`)
      .expect(400);
    await request(app.getHttpServer())
      .get('/api/monitors/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/check-rounds')
      .expect(404);
  });

  it('does not create or reveal manual rounds for unknown monitor identities', async () => {
    const unknownMonitorId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const unknownRoundId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

    await request(app.getHttpServer())
      .post(`/api/monitors/${unknownMonitorId}/check-rounds`)
      .expect(404)
      .expect(({ body }) => {
        expect(body).toMatchObject({ code: 'MONITOR_NOT_FOUND' });
      });

    await request(app.getHttpServer())
      .get(`/api/monitors/${unknownMonitorId}/check-rounds/${unknownRoundId}`)
      .expect(404)
      .expect(({ body }) => {
        expect(body).toMatchObject({ code: 'CHECK_ROUND_NOT_FOUND' });
      });
  });
});
