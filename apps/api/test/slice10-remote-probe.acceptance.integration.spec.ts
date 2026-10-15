import 'reflect-metadata';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { INestApplication } from '@nestjs/common';
import { getDrizzleToken } from '@nestjs/drizzle';
import { Test } from '@nestjs/testing';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import {
  createDatabaseConnection,
  migrateDatabase,
  ProbeCoordinatorRepository,
  ScheduledRoundRepository,
  type WatchrailDatabase,
} from '@watchrail/db';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';

const sentinel = 'WATCHRAIL_REMOTE_ACCEPTANCE_SECRET';

interface AcceptanceRound {
  status: string;
  assignmentStatus: string;
  location: string | null;
  result: Record<string, unknown> | null;
}

describe('Slice 10 remote probe acceptance', () => {
  let app: INestApplication;
  let container: StartedPostgreSqlContainer;
  let database: WatchrailDatabase;
  let target: Server;
  let targetStatus = 200;
  let targetAuthorization: string | undefined;
  let temporaryDirectory: string;
  let agent: ChildProcess | undefined;
  let agentOutput = '';

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
    const migration = createDatabaseConnection(container.getConnectionUri());
    await migrateDatabase(migration, resolve(process.cwd(), '../../packages/db/drizzle'));
    await migration.pool.end();
    const module = await Test.createTestingModule({ imports: [AppModule] }).compile();
    database = module.get<WatchrailDatabase>(getDrizzleToken());
    app = module.createNestApplication();
    app.setGlobalPrefix('api');
    await app.listen(0, '127.0.0.1');

    target = createServer((request_, response) => {
      targetAuthorization = request_.headers.authorization;
      response.writeHead(targetStatus, { 'content-type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ status: targetStatus === 200 ? 'ready' : 'unavailable' }));
    });
    await new Promise<void>((resolveListen) => target.listen(0, '127.0.0.1', resolveListen));
    temporaryDirectory = await mkdtemp(resolve(tmpdir(), 'watchrail-slice10-'));
  }, 60_000);

  afterAll(async () => {
    await stopAgent();
    await app?.close();
    await new Promise<void>((resolveClose) => target?.close(() => resolveClose()));
    await container?.stop();
    if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true });
  });

  it('runs the standalone agent through enrollment, routing, results, incidents, recovery, and missing capacity', async () => {
    const location = (
      await request(app.getHttpServer())
        .post('/api/probe-locations')
        .send({ name: 'Acceptance Lagos', slug: 'acceptance-lagos' })
        .expect(201)
    ).body.data as { id: string };
    const enrollment = (
      await request(app.getHttpServer())
        .post(`/api/probe-locations/${location.id}/enrollments`)
        .send({ agentName: 'acceptance-agent' })
        .expect(201)
    ).body.data as { id: string; token: string };
    const targetAddress = target.address() as AddressInfo;
    const monitor = (
      await request(app.getHttpServer())
        .post('/api/monitors')
        .send({
          name: 'Remote acceptance monitor',
          url: `http://acceptance.test:${targetAddress.port}/health`,
        })
        .expect(201)
    ).body.data as { id: string };
    await request(app.getHttpServer())
      .patch(`/api/monitors/${monitor.id}/request-headers`)
      .send({
        requestHeaders: [{ name: 'authorization', sensitive: true, value: `Bearer ${sentinel}` }],
      })
      .expect(200);
    await request(app.getHttpServer())
      .patch(`/api/monitors/${monitor.id}/locations`)
      .send({ locations: [location.id] })
      .expect(200)
      .expect(({ body }) => expect(body.data.locations).toEqual([location.id]));

    const manualRound = (
      await request(app.getHttpServer())
        .post(`/api/monitors/${monitor.id}/check-rounds`)
        .expect(202)
    ).body.data as { id: string };
    startAgent(enrollment);
    const manual = await waitForRound(monitor.id, manualRound.id);
    expect(manual).toMatchObject({
      status: 'COMPLETED',
      assignmentStatus: 'COMPLETED',
      location: location.id,
      result: { outcome: 'PASS', stage: 'HTTP', reason: 'COMPLETED', statusCode: 200 },
    });
    expect(targetAuthorization).toBe(`Bearer ${sentinel}`);

    targetStatus = 503;
    const scheduled = new ScheduledRoundRepository(database);
    for (let index = 0; index < 3; index += 1) {
      await makeDue(monitor.id);
      const [round] = await scheduled.dispatchDue(1);
      expect(round?.trigger).toBe('SCHEDULED');
      const completed = await waitForRound(monitor.id, round!.id);
      expect(completed.result).toMatchObject({
        outcome: 'FAIL',
        stage: 'HTTP',
        reason: 'UNEXPECTED_STATUS',
        statusCode: 503,
      });
    }
    expect(
      (
        await database.$client.query<{ status: string }>(
          'select status from incidents where monitor_id=$1',
          [monitor.id],
        )
      ).rows,
    ).toEqual([{ status: 'OPEN' }]);
    expect(
      (
        await database.$client.query<{ event_type: string }>(
          'select event_type from notification_events where monitor_id=$1 order by created_at',
          [monitor.id],
        )
      ).rows,
    ).toEqual([{ event_type: 'INCIDENT_OPENED' }]);

    targetStatus = 200;
    await makeDue(monitor.id);
    const [recoveryRound] = await scheduled.dispatchDue(1);
    await waitForRound(monitor.id, recoveryRound!.id);
    expect(
      (
        await database.$client.query<{ status: string }>(
          'select status from incidents where monitor_id=$1',
          [monitor.id],
        )
      ).rows,
    ).toEqual([{ status: 'RESOLVED' }]);
    expect(
      (
        await database.$client.query<{ event_type: string }>(
          'select event_type from notification_events where monitor_id=$1 order by created_at',
          [monitor.id],
        )
      ).rows.map(({ event_type }) => event_type),
    ).toEqual(['INCIDENT_OPENED', 'INCIDENT_RESOLVED']);

    const credentialFile = resolve(temporaryDirectory, 'credential');
    expect((await stat(credentialFile)).mode & 0o777).toBe(0o600);
    const credential = (await readFile(credentialFile, 'utf8')).trim();
    expect(credential).toMatch(/^[A-Za-z0-9_-]{43}$/u);

    await stopAgent();
    expect(agentOutput).not.toContain(enrollment.token);
    expect(agentOutput).not.toContain(credential);
    expect(agentOutput).not.toContain(sentinel);

    await makeDue(monitor.id);
    const [missingCapacityRound] = await scheduled.dispatchDue(1);
    await database.$client.query(
      `update check_execution_assignments
          set pending_since=clock_timestamp()-interval '11 seconds'
        where round_id=$1`,
      [missingCapacityRound!.id],
    );
    expect(await new ProbeCoordinatorRepository(database).reconcileExpired(1, 10_000)).toBe(1);
    const missingCapacity = await waitForRound(monitor.id, missingCapacityRound!.id);
    expect(missingCapacity.result).toMatchObject({
      outcome: 'UNKNOWN',
      stage: 'PROBE',
      reason: 'INTERNAL_ERROR',
    });
    expect(
      (
        await database.$client.query<{ status: string }>(
          'select status from incidents where monitor_id=$1',
          [monitor.id],
        )
      ).rows,
    ).toEqual([{ status: 'RESOLVED' }]);
  }, 60_000);

  function startAgent(enrollment: { id: string; token: string }): void {
    const address = app.getHttpServer().address() as AddressInfo;
    agent = spawn(
      process.execPath,
      [resolve(process.cwd(), '../../tooling/probe-agent-acceptance-process.mjs')],
      {
        cwd: resolve(process.cwd(), '../..'),
        env: {
          ...process.env,
          NODE_ENV: 'test',
          PROBE_COORDINATOR_URL: `http://127.0.0.1:${address.port}`,
          PROBE_ENROLLMENT_ID: enrollment.id,
          PROBE_ENROLLMENT_TOKEN: enrollment.token,
          PROBE_CREDENTIAL_FILE: resolve(temporaryDirectory, 'credential'),
          PROBE_POLL_INTERVAL_MS: '1000',
          PROBE_HEARTBEAT_INTERVAL_MS: '5000',
          PROBE_RENEWAL_INTERVAL_MS: '5000',
          PROBE_COORDINATOR_REQUEST_TIMEOUT_MS: '3000',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    agent.stdout?.on('data', (chunk: Buffer) => (agentOutput += chunk.toString('utf8')));
    agent.stderr?.on('data', (chunk: Buffer) => (agentOutput += chunk.toString('utf8')));
  }

  async function stopAgent(): Promise<void> {
    if (!agent || agent.exitCode !== null) return;
    const stopped = new Promise<void>((resolveExit) => agent!.once('exit', () => resolveExit()));
    agent.kill('SIGTERM');
    await Promise.race([
      stopped,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`Probe agent did not stop. ${agentOutput}`)), 5_000),
      ),
    ]);
  }

  async function makeDue(monitorId: string): Promise<void> {
    await database.$client.query(
      `update monitors set next_check_at=clock_timestamp()-interval '1 second' where id=$1`,
      [monitorId],
    );
  }

  async function waitForRound(monitorId: string, roundId: string): Promise<AcceptanceRound> {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const response = await request(app.getHttpServer()).get(
        `/api/monitors/${monitorId}/check-rounds/${roundId}`,
      );
      if (response.status === 200 && response.body.data?.status === 'COMPLETED') {
        return response.body.data as AcceptanceRound;
      }
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
    }
    throw new Error(`Timed out waiting for round ${roundId}. Agent output: ${agentOutput}`);
  }
});
