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
      statusPolicy: { type: 'ANY_2XX' },
      locations: ['local'],
    });

    const listed = await request(app.getHttpServer()).get('/api/monitors').expect(200);
    expect(listed.body.data).toHaveLength(1);
    expect(listed.body.data[0].id).toBe(created.body.data.id);
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
      status: 'PENDING',
      assignmentStatus: 'PENDING',
      result: null,
    });

    const executions = new CheckExecutionRepository(database);
    const claim = await executions.claim(roundId, 30_000);
    expect(claim.state).toBe('CLAIMED');
    if (claim.state !== 'CLAIMED') throw new Error('Expected the round to be claimable.');

    const checkedAt = new Date('2026-09-24T12:00:00.000Z');
    await executions.complete(claim.execution.assignmentId, claim.execution.claimToken, {
      outcome: 'PASS',
      stage: 'HTTP',
      reason: 'COMPLETED',
      statusCode: 200,
      responseTimeMs: 42.5,
      attemptDurationMs: 46.25,
      checkedAt,
    });

    const completed = await request(app.getHttpServer())
      .get(`/api/monitors/${monitorId}/check-rounds/${roundId}`)
      .expect(200);

    expect(completed.body.data).toEqual({
      id: roundId,
      monitorId,
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
        checkedAt: checkedAt.toISOString(),
      },
    });
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
