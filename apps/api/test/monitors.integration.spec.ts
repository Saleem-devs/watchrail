import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { Logger, type INestApplication } from '@nestjs/common';
import { getDrizzleToken } from '@nestjs/drizzle';
import { Test } from '@nestjs/testing';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import {
  CheckExecutionRepository,
  createDatabaseConnection,
  migrateDatabase,
  MonitorRepository,
  ManualRoundRepository,
  MultiLocationRoundFinalizationRepository,
  ProjectRepository,
} from '@watchrail/db';
import { createMonitor, parseNewProject } from '@watchrail/domain';
import type { WatchrailDatabase } from '@watchrail/db';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { NodeHttpExecutor, type HttpExecutor } from '@watchrail/check-engine';

describe('monitor API', () => {
  let app: INestApplication;
  let container: StartedPostgreSqlContainer;
  let database: WatchrailDatabase;
  let projectId: string;
  const executeTransient = vi.fn<HttpExecutor['execute']>();

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:18.0-alpine').start();
    process.env.NODE_ENV = 'test';
    process.env.DATABASE_URL = container.getConnectionUri();
    process.env.DEV_IDENTITY_ENABLED = 'true';
    process.env.MULTI_LOCATION_EXECUTION_ENABLED = 'true';
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

    const migrationConnection = createDatabaseConnection(container.getConnectionUri());
    await migrateDatabase(migrationConnection, resolve(process.cwd(), '../../packages/db/drizzle'));
    await migrationConnection.pool.end();

    const testingModule = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(NodeHttpExecutor)
      .useValue({ execute: executeTransient })
      .compile();
    database = testingModule.get<WatchrailDatabase>(getDrizzleToken());
    app = testingModule.createNestApplication();
    app.setGlobalPrefix('api');
    await app.init();
    await app.listen(0, '127.0.0.1');
  }, 60_000);

  beforeEach(async () => {
    executeTransient.mockReset();
    executeTransient.mockResolvedValue({
      type: 'RESPONSE',
      statusCode: 200,
      responseTimeMs: 12,
      headers: [{ name: 'content-type', values: ['application/json'] }],
      body: { state: 'CAPTURED', text: '{"ready":true}' },
      redirects: [],
    });
    const connection = createDatabaseConnection(container.getConnectionUri());
    await connection.pool.query(`
      truncate table
        check_execution_results,
        check_round_outbox,
        check_execution_assignments,
        check_rounds,
        monitor_configuration_versions,
        monitors,
        projects
      cascade
    `);
    await connection.pool.end();
    const project = await new ProjectRepository(database).create(
      '00000000-0000-4000-8000-000000000002',
      parseNewProject({ name: 'Monitor API', slug: 'monitor-api' }),
    );
    projectId = project.id;
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
      .post(`/api/monitors?projectId=${projectId}`)
      .send({
        name: 'Public API',
        url: 'https://example.com/health',
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

  it('replaces the immutable execution location with an owned active remote location', async () => {
    const monitor = await request(app.getHttpServer())
      .post(`/api/monitors?projectId=${projectId}`)
      .send({ name: 'Remote API', url: 'https://example.com/health' })
      .expect(201);
    const location = await request(app.getHttpServer())
      .post('/api/probe-locations')
      .send({ name: 'Lagos', slug: 'lagos' })
      .expect(201);

    const updated = await request(app.getHttpServer())
      .patch(`/api/monitors/${monitor.body.data.id as string}/locations`)
      .send({ locations: [location.body.data.id] })
      .expect(200);
    expect(updated.body.data.locations).toEqual([location.body.data.id]);

    const versions = await database.$client.query<{ locations: string[] }>(
      'select locations from monitor_configuration_versions where monitor_id=$1 order by version_number',
      [monitor.body.data.id],
    );
    expect(versions.rows.map((row) => row.locations)).toEqual([['local'], [location.body.data.id]]);

    await request(app.getHttpServer())
      .patch(`/api/probe-locations/${location.body.data.id as string}/status`)
      .send({ status: 'DISABLED' })
      .expect(200);
    await request(app.getHttpServer())
      .patch(`/api/monitors/${monitor.body.data.id as string}/locations`)
      .send({ locations: [location.body.data.id] })
      .expect(409);
  });

  it('reads live uptime and daily metrics without materializing the tail, retaining metrics through mutations', async () => {
    const created = await request(app.getHttpServer())
      .post(`/api/monitors?projectId=${projectId}`)
      .send({ name: 'Uptime API', url: 'https://example.com' })
      .expect(201);
    const monitorId = created.body.data.id as string;
    await database.$client.query(
      `update monitor_availability_state set current_state='AVAILABLE', tracking_started_at=date_trunc('day',clock_timestamp() at time zone 'UTC') at time zone 'UTC', state_since=date_trunc('day',clock_timestamp() at time zone 'UTC') at time zone 'UTC', accounted_through=date_trunc('day',clock_timestamp() at time zone 'UTC') at time zone 'UTC', enabled_since=date_trunc('day',clock_timestamp() at time zone 'UTC') at time zone 'UTC' where monitor_id=$1`,
      [monitorId],
    );
    const before = (
      await database.$client.query('select * from monitor_availability_state where monitor_id=$1', [
        monitorId,
      ])
    ).rows;
    const uptime = await request(app.getHttpServer())
      .get(`/api/monitors/${monitorId}/uptime?window=7d`)
      .expect(200);
    expect(uptime.body.data).toMatchObject({
      uptimePercent: 100,
      coveragePercent: 100,
      durations: { unavailableMs: 0, unknownMs: 0, excludedMs: 0 },
    });
    expect(uptime.body.data.durations.availableMs).toBe(
      new Date(uptime.body.data.window.end as string).getTime() -
        new Date(uptime.body.data.window.start as string).getTime(),
    );
    const daily = await request(app.getHttpServer())
      .get(`/api/monitors/${monitorId}/uptime/daily?window=30d`)
      .expect(200);
    expect(daily.body.data.days).toHaveLength(1);
    expect(daily.body.data.days[0]).toMatchObject({ uptimePercent: 100, coveragePercent: 100 });
    const listed = await request(app.getHttpServer()).get('/api/monitors').expect(200);
    expect(listed.body.data[0].uptime).toMatchObject({ uptimePercent: 100, coveragePercent: 100 });
    const saved = await request(app.getHttpServer())
      .patch(`/api/monitors/${monitorId}/status-policy`)
      .send({ statusPolicy: { type: 'EXACT', statusCodes: [204] } })
      .expect(200);
    expect(saved.body.data.uptime).toMatchObject({ uptimePercent: 100, coveragePercent: 100 });
    expect(
      (
        await database.$client.query(
          'select * from monitor_availability_state where monitor_id=$1',
          [monitorId],
        )
      ).rows,
    ).toEqual(before);
    expect((await database.$client.query('select * from monitor_availability_daily')).rows).toEqual(
      [],
    );
  });

  it('validates uptime presets, isolates organizations, and allows archived reads', async () => {
    const created = await request(app.getHttpServer())
      .post(`/api/monitors?projectId=${projectId}`)
      .send({ name: 'Uptime validation', url: 'https://example.com' })
      .expect(201);
    const monitorId = created.body.data.id as string;
    for (const suffix of ['uptime', 'uptime/daily']) {
      for (const query of ['window=24h', 'window=7d&window=30d', 'window=', 'extra=true']) {
        await request(app.getHttpServer())
          .get(`/api/monitors/${monitorId}/${suffix}?${query}`)
          .expect(400);
      }
      await request(app.getHttpServer())
        .get(`/api/monitors/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/${suffix}`)
        .expect(404);
      await request(app.getHttpServer()).get(`/api/monitors/not-a-uuid/${suffix}`).expect(400);
    }
    await request(app.getHttpServer())
      .patch(`/api/monitors/${monitorId}/lifecycle`)
      .send({ lifecycleState: 'ARCHIVED' })
      .expect(200);
    await request(app.getHttpServer()).get(`/api/monitors/${monitorId}/uptime`).expect(200);
    await request(app.getHttpServer()).get(`/api/monitors/${monitorId}/uptime/daily`).expect(200);
    const foreign = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    // A genuine foreign monitor is created through its repository, not by bypassing composite FKs.
    const record = await new MonitorRepository(database).create(
      foreign,
      createMonitor({ name: 'Foreign', url: 'https://example.com' }),
    );
    await request(app.getHttpServer()).get(`/api/monitors/${record.id}/uptime`).expect(404);
    await request(app.getHttpServer()).get(`/api/monitors/${record.id}/uptime/daily`).expect(404);
  });

  it('uses one shared cutoff across the monitor-list uptime projection', async () => {
    for (const name of ['First uptime', 'Second uptime']) {
      await request(app.getHttpServer())
        .post(`/api/monitors?projectId=${projectId}`)
        .send({ name, url: 'https://example.com' })
        .expect(201);
    }
    const listed = await request(app.getHttpServer()).get('/api/monitors').expect(200);
    expect(listed.body.data[0].uptime.window.end).toBe(listed.body.data[1].uptime.window.end);
    expect(listed.body.data[0].uptime.uptimePercent).toBeNull();
    expect(listed.body.data[0].uptime.coveragePercent).toBe(0);
  });

  it('versions interval settings and enforces lifecycle scheduling invariants', async () => {
    const beforeCreate = Date.now();
    const created = await request(app.getHttpServer())
      .post(`/api/monitors?projectId=${projectId}`)
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
      .post(`/api/monitors?projectId=${projectId}`)
      .send({ name: 'Schedule validation', url: 'https://example.com' })
      .expect(201);
    await request(app.getHttpServer())
      .patch(`/api/monitors/${created.body.data.id as string}/schedule-settings`)
      .send(body)
      .expect(400);
  });

  it('preserves interval settings through every unrelated configuration writer', async () => {
    const created = await request(app.getHttpServer())
      .post(`/api/monitors?projectId=${projectId}`)
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

  it('preserves the request body in execution snapshots after header and assertion updates', async () => {
    const requestBody = { type: 'JSON', value: '{"query":"health"}' } as const;
    const created = await request(app.getHttpServer())
      .post(`/api/monitors?projectId=${projectId}`)
      .send({
        name: 'Body-preserving API',
        url: 'https://example.com/graphql',
        method: 'POST',
        requestBody,
      })
      .expect(201);
    const monitorId = created.body.data.id as string;

    await request(app.getHttpServer())
      .patch(`/api/monitors/${monitorId}/request-headers`)
      .send({
        requestHeaders: [{ name: 'content-type', sensitive: false, value: 'application/json' }],
      })
      .expect(200);
    await request(app.getHttpServer())
      .patch(`/api/monitors/${monitorId}/assertions`)
      .send({
        headers: [
          {
            name: 'content-type',
            operator: 'contains',
            target: { sensitive: false, value: 'json' },
          },
        ],
        textBody: [],
        jsonBody: [],
      })
      .expect(200);

    const versions = await database.$client.query<{
      version_number: number;
      request_body: unknown;
    }>(
      `select version_number, request_body
       from monitor_configuration_versions
       where monitor_id = $1
       order by version_number`,
      [monitorId],
    );
    expect(versions.rows).toEqual([
      { version_number: 1, request_body: requestBody },
      { version_number: 2, request_body: requestBody },
      { version_number: 3, request_body: requestBody },
    ]);

    const round = await request(app.getHttpServer())
      .post(`/api/monitors/${monitorId}/check-rounds`)
      .expect(202);
    const claim = await new CheckExecutionRepository(database).claim(
      round.body.data.id as string,
      30_000,
    );
    expect(claim).toMatchObject({
      state: 'CLAIMED',
      execution: { requestBody },
    });
  });

  it('normalizes and versions exact status-policy edits', async () => {
    const created = await request(app.getHttpServer())
      .post(`/api/monitors?projectId=${projectId}`)
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
      .post(`/api/monitors?projectId=${projectId}`)
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
    [{ url: 'https://example.com', method: 'GET', timeoutMs: 999, followRedirects: true }],
    [{ url: 'https://example.com', method: 'GET', timeoutMs: 30_001, followRedirects: true }],
    [{ url: 'https://example.com', method: 'GET', timeoutMs: 5_000, followRedirects: 'false' }],
  ])('rejects invalid HTTP settings %#', async (settings) => {
    const created = await request(app.getHttpServer())
      .post(`/api/monitors?projectId=${projectId}`)
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
      .post(`/api/monitors?projectId=${projectId}`)
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
      .post(`/api/monitors?projectId=${projectId}`)
      .send({
        name: 'Unsafe headers',
        url: 'https://example.com',
        requestHeaders: [{ name: 'Host', sensitive: false, value: 'internal.example' }],
      })
      .expect(400);

    const created = await request(app.getHttpServer())
      .post(`/api/monitors?projectId=${projectId}`)
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
      .post(`/api/monitors?projectId=${projectId}`)
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

  it('creates a monitor with response assertions and rejects configurations above the limit', async () => {
    const sentinel = 'WATCHRAIL_CREATE_ASSERTION_SECRET';
    const created = await request(app.getHttpServer())
      .post(`/api/monitors?projectId=${projectId}`)
      .send({
        name: 'Configured at creation',
        url: 'https://example.com/health',
        assertions: {
          headers: [
            {
              name: 'content-type',
              operator: 'contains',
              target: { sensitive: false, value: 'json' },
            },
          ],
          textBody: [{ operator: 'not_contains', target: { sensitive: true, value: sentinel } }],
          jsonBody: [
            {
              selector: '$.healthy',
              operator: 'equals',
              target: { sensitive: false, value: { type: 'boolean', value: true } },
            },
          ],
        },
      })
      .expect(201);

    expect(created.body.data.assertions).toMatchObject({
      assertions: {
        headers: [{ target: { sensitive: false, value: 'json' } }],
        textBody: [{ target: { sensitive: true, hasValue: true } }],
        jsonBody: [{ target: { sensitive: false, value: { type: 'boolean', value: true } } }],
      },
    });
    expect(JSON.stringify(created.body)).not.toContain(sentinel);
    const stored = await database.$client.query<{ assertions: unknown }>(
      'select assertions from monitors where id = $1',
      [created.body.data.id],
    );
    expect(JSON.stringify(stored.rows)).not.toContain(sentinel);

    const tooMany = Array.from({ length: 33 }, (_, index) => ({
      name: `x-check-${index}`,
      operator: 'exists',
    }));
    const rejected = await request(app.getHttpServer())
      .post(`/api/monitors?projectId=${projectId}`)
      .send({
        name: 'Too many assertions',
        url: 'https://example.com',
        assertions: { headers: tooMany, textBody: [], jsonBody: [] },
      })
      .expect(400);
    expect(rejected.body.fields.assertions[0]).toContain('at most 32 assertions');
  });

  it('enforces HEAD and body-assertion compatibility in both update directions', async () => {
    const created = await request(app.getHttpServer())
      .post(`/api/monitors?projectId=${projectId}`)
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
      .post(`/api/monitors?projectId=${projectId}`)
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

  it('atomically switches to HEAD while removing body assertions', async () => {
    const created = await request(app.getHttpServer())
      .post(`/api/monitors?projectId=${projectId}`)
      .send({
        name: 'Atomic HEAD transition',
        url: 'https://example.com',
        assertions: {
          headers: [],
          textBody: [{ operator: 'contains', target: { sensitive: false, value: 'ready' } }],
          jsonBody: [],
        },
      })
      .expect(201);
    const monitorId = created.body.data.id as string;
    const httpSettings = {
      url: 'https://example.com',
      method: 'HEAD',
      timeoutMs: 10_000,
      followRedirects: true,
      requestBody: { type: 'NONE' },
    } as const;

    await request(app.getHttpServer())
      .patch(`/api/monitors/${monitorId}/configuration`)
      .send({
        httpSettings,
        requestHeaders: [],
        assertions: {
          headers: [],
          textBody: [{ operator: 'contains', target: { sensitive: false, value: 'ready' } }],
          jsonBody: [],
        },
      })
      .expect(400);

    const afterRejected = await database.$client.query<{
      method: string;
      version_count: number;
    }>(
      `select m.method, count(v.id)::int as version_count
       from monitors m
       join monitor_configuration_versions v on v.monitor_id = m.id
       where m.id = $1
       group by m.method`,
      [monitorId],
    );
    expect(afterRejected.rows).toEqual([{ method: 'GET', version_count: 1 }]);

    const updated = await request(app.getHttpServer())
      .patch(`/api/monitors/${monitorId}/configuration`)
      .send({
        httpSettings,
        requestHeaders: [],
        assertions: { headers: [], textBody: [], jsonBody: [] },
      })
      .expect(200);
    expect(updated.body.data).toMatchObject({
      method: 'HEAD',
      assertions: {
        contractVersion: 1,
        assertions: { headers: [], textBody: [], jsonBody: [] },
      },
    });

    const versions = await database.$client.query<{
      version_number: number;
      method: string;
      assertions: { assertions: { textBody: unknown[] } };
    }>(
      `select version_number, method, assertions
       from monitor_configuration_versions
       where monitor_id = $1
       order by version_number`,
      [monitorId],
    );
    expect(versions.rows).toHaveLength(2);
    expect(versions.rows[1]).toMatchObject({
      version_number: 2,
      method: 'HEAD',
      assertions: { assertions: { textBody: [] } },
    });
  });

  it('tests an unsaved configuration with retained secrets without creating monitoring state', async () => {
    executeTransient.mockResolvedValueOnce({
      type: 'RESPONSE',
      statusCode: 202,
      responseTimeMs: 17,
      headers: [
        { name: 'content-type', values: ['application/json'] },
        { name: 'set-cookie', values: ['session=response-secret'] },
        { name: 'x-state', values: ['ready'] },
      ],
      body: {
        state: 'CAPTURED',
        text: '{"token":"body-request-secret","echo":"assertion-secret","ready":true}',
      },
      redirects: [],
    });
    const created = await request(app.getHttpServer())
      .post(`/api/monitors?projectId=${projectId}`)
      .send({
        name: 'Transient diagnostic',
        url: 'https://example.com/jobs',
        method: 'POST',
        requestBody: { type: 'JSON', value: '{"saved":true}' },
        requestHeaders: [
          { name: 'Authorization', sensitive: true, value: 'Bearer request-secret' },
        ],
        assertions: {
          headers: [],
          textBody: [
            { operator: 'contains', target: { sensitive: true, value: 'assertion-secret' } },
          ],
          jsonBody: [],
        },
      })
      .expect(201);
    const monitorId = created.body.data.id as string;
    const before = await database.$client.query<{ rounds: number; versions: number }>(
      `select
         (select count(*)::int from check_rounds) as rounds,
         (select count(*)::int from monitor_configuration_versions) as versions`,
    );

    const tested = await request(app.getHttpServer())
      .post(`/api/monitors/${monitorId}/test-configuration?projectId=${projectId}`)
      .send({
        httpSettings: {
          url: 'https://example.com/jobs?dryRun=true',
          method: 'POST',
          timeoutMs: 8_000,
          followRedirects: true,
          requestBody: { type: 'JSON', value: '{"token":"body-request-secret"}' },
        },
        statusPolicy: { type: 'EXACT', statusCodes: [202] },
        requestHeaders: [{ name: 'authorization', sensitive: true, retain: true }],
        assertions: {
          headers: [],
          textBody: [{ operator: 'contains', target: { sensitive: true, retain: true } }],
          jsonBody: [],
        },
      })
      .expect(201);

    expect(tested.body.data).toMatchObject({
      result: { statusCode: 202, outcome: 'PASS' },
      signals: { transport: 'PASS', statusPolicy: 'PASS', assertions: 'PASS' },
      response: {
        headers: expect.arrayContaining([
          { name: 'set-cookie', values: ['[REDACTED]'], redacted: true },
        ]),
        body: { state: 'PREVIEW' },
      },
    });
    expect(JSON.stringify(tested.body)).not.toContain('request-secret');
    expect(JSON.stringify(tested.body)).not.toContain('assertion-secret');
    expect(JSON.stringify(tested.body)).not.toContain('body-request-secret');
    expect(executeTransient).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'POST',
        url: 'https://example.com/jobs?dryRun=true',
        captureResponseBody: true,
        requestHeaders: [{ name: 'authorization', value: 'Bearer request-secret' }],
        requestBody: expect.objectContaining({ contentType: 'application/json' }),
      }),
    );
    expect(
      await database.$client.query('select count(*)::int as count from check_execution_results'),
    ).toMatchObject({ rows: [{ count: 0 }] });
    expect(
      await database.$client.query('select count(*)::int as count from incidents'),
    ).toMatchObject({ rows: [{ count: 0 }] });
    expect(
      await database.$client.query(
        `select
           (select count(*)::int from check_rounds) as rounds,
           (select count(*)::int from monitor_configuration_versions) as versions`,
      ),
    ).toMatchObject({ rows: before.rows });

    const otherProject = await new ProjectRepository(database).create(
      '00000000-0000-4000-8000-000000000002',
      parseNewProject({ name: 'Other project', slug: 'other-project' }),
    );
    await request(app.getHttpServer())
      .post(`/api/monitors/${monitorId}/test-configuration?projectId=${otherProject.id}`)
      .send({})
      .expect(404);
  });

  it('redacts camel-case request secrets reflected under ordinary response keys and in text', async () => {
    executeTransient
      .mockResolvedValueOnce({
        type: 'RESPONSE',
        statusCode: 200,
        responseTimeMs: 9,
        headers: [{ name: 'content-type', values: ['application/json'] }],
        body: {
          state: 'CAPTURED',
          text: JSON.stringify({ echo: 'abc123', detail: 'credential-value' }),
        },
        redirects: [],
      })
      .mockResolvedValueOnce({
        type: 'RESPONSE',
        statusCode: 200,
        responseTimeMs: 7,
        headers: [{ name: 'content-type', values: ['text/plain'] }],
        body: { state: 'CAPTURED', text: 'received abc123 and credential-value' },
        redirects: [],
      });

    const configuration = {
      httpSettings: {
        url: 'https://example.com/echo',
        method: 'POST',
        timeoutMs: 8_000,
        followRedirects: true,
        requestBody: {
          type: 'JSON',
          value: JSON.stringify({ accessToken: 'abc123', credentials: 'credential-value' }),
        },
      },
      statusPolicy: { type: 'ANY_2XX' },
      requestHeaders: [],
      assertions: { headers: [], textBody: [], jsonBody: [] },
    };

    const jsonResponse = await request(app.getHttpServer())
      .post(`/api/monitors/test-configuration?projectId=${projectId}`)
      .send(configuration)
      .expect(201);
    const textResponse = await request(app.getHttpServer())
      .post(`/api/monitors/test-configuration?projectId=${projectId}`)
      .send(configuration)
      .expect(201);

    for (const response of [jsonResponse, textResponse]) {
      expect(JSON.stringify(response.body)).not.toMatch(/abc123|credential-value/u);
      expect(JSON.stringify(response.body)).toContain('[REDACTED]');
    }
  });

  it('validates create-form configuration tests without saving a monitor', async () => {
    const before = await database.$client.query('select count(*)::int as count from monitors');
    await request(app.getHttpServer())
      .post(`/api/monitors/test-configuration?projectId=${projectId}`)
      .send({
        httpSettings: {
          url: 'https://example.com/health',
          method: 'HEAD',
          timeoutMs: 5_000,
          followRedirects: false,
          requestBody: { type: 'NONE' },
        },
        statusPolicy: { type: 'ANY_2XX' },
        requestHeaders: [],
        assertions: {
          headers: [],
          textBody: [{ operator: 'contains', target: { sensitive: false, value: 'ready' } }],
          jsonBody: [],
        },
      })
      .expect(400);
    expect(
      await database.$client.query('select count(*)::int as count from monitors'),
    ).toMatchObject({
      rows: before.rows,
    });
  });

  it('does not expose a sentinel from corrupted stored headers in API errors', async () => {
    const sentinel = 'WATCHRAIL_SENTINEL_SECRET';
    const logger = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const created = await request(app.getHttpServer())
      .post(`/api/monitors?projectId=${projectId}`)
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
      .post(`/api/monitors?projectId=${projectId}`)
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
      .post(`/api/monitors?projectId=${projectId}`)
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
      .post(`/api/monitors?projectId=${projectId}`)
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
      location: 'local',
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

  it('returns one aggregate history row with regional diagnostic drill-down', async () => {
    const created = await request(app.getHttpServer())
      .post(`/api/monitors?projectId=${projectId}`)
      .send({ name: 'Regional API history', url: 'https://example.com/health' })
      .expect(201);
    const monitorId = created.body.data.id as string;
    const locations = [] as string[];
    for (const slug of ['regional-api-lagos', 'regional-api-frankfurt']) {
      const response = await request(app.getHttpServer())
        .post('/api/probe-locations')
        .send({ name: slug, slug })
        .expect(201);
      locations.push(response.body.data.id as string);
    }
    await request(app.getHttpServer())
      .patch(`/api/monitors/${monitorId}/locations`)
      .send({ locations })
      .expect(200);
    const round = await new ManualRoundRepository(database, true).create(
      '00000000-0000-4000-8000-000000000002',
      monitorId,
    );
    const finalizer = new MultiLocationRoundFinalizationRepository(database);
    for (const [index, location] of locations.entries()) {
      const assignment = await database.$client.query<{ id: string }>(
        'select id from check_execution_assignments where round_id=$1 and location=$2',
        [round.id, location],
      );
      await finalizer.recordExecution({
        organizationId: '00000000-0000-4000-8000-000000000002',
        roundId: round.id,
        assignmentId: assignment.rows[0]!.id,
        location,
        executionId: randomUUID(),
        agentId: `api-agent-${index}`,
        role: 'PRIMARY',
        observation: { outcome: 'PASS', reason: 'COMPLETED', assertionOutcome: 'PASS' },
        diagnosticSummary: {
          stage: 'HTTP',
          reason: 'COMPLETED',
          statusCode: 200,
          responseTimeMs: 15,
          attemptDurationMs: 20,
          checkedAt: new Date().toISOString(),
          assertionEvaluation: {
            contractVersion: 1,
            outcome: 'PASS',
            diagnostics: [
              {
                index: 0,
                source: 'HEADER',
                subject: 'content-type',
                operator: 'contains',
                outcome: 'PASS',
                reason: 'MATCHED',
              },
            ],
          },
        },
      });
    }

    const list = await request(app.getHttpServer())
      .get(`/api/monitors/${monitorId}/check-rounds`)
      .expect(200);
    expect(list.body.data).toHaveLength(1);
    expect(list.body.data[0]).toMatchObject({
      id: round.id,
      result: { kind: 'MULTI_LOCATION', outcome: 'UP', counts: { selected: 2, pass: 2 } },
    });
    const detail = await request(app.getHttpServer())
      .get(`/api/monitors/${monitorId}/check-rounds/${round.id}`)
      .expect(200);
    expect(detail.body.data).toMatchObject({
      result: {
        kind: 'MULTI_LOCATION',
        outcome: 'UP',
        regions: [
          {
            outcome: 'PASS',
            executions: [
              {
                diagnosticSummary: {
                  statusCode: 200,
                  assertionEvaluation: { outcome: 'PASS', diagnostics: [{ source: 'HEADER' }] },
                },
              },
            ],
          },
          {
            outcome: 'PASS',
            executions: [
              {
                diagnosticSummary: {
                  statusCode: 200,
                  assertionEvaluation: { outcome: 'PASS', diagnostics: [{ source: 'HEADER' }] },
                },
              },
            ],
          },
        ],
      },
    });
    const monitors = await request(app.getHttpServer()).get('/api/monitors').expect(200);
    expect(monitors.body.data[0].currentCheck).toMatchObject({
      kind: 'MULTI_LOCATION',
      aggregateOutcome: 'UP',
      coverage: { numerator: 2, denominator: 2 },
    });
  });

  it('rejects invalid history queries and isolates monitor history', async () => {
    const created = await request(app.getHttpServer())
      .post(`/api/monitors?projectId=${projectId}`)
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
