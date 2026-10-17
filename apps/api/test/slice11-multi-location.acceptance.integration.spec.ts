import 'reflect-metadata';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { createDatabaseConnection, migrateDatabase } from '@watchrail/db';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';

interface AgentProcess {
  child: ChildProcess;
  output: string;
  directory: string;
}

describe('Slice 11 multi-location acceptance', () => {
  let app: INestApplication;
  let container: StartedPostgreSqlContainer;
  let target: Server;
  const agents: AgentProcess[] = [];

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
    const migration = createDatabaseConnection(container.getConnectionUri());
    await migrateDatabase(migration, resolve(process.cwd(), '../../packages/db/drizzle'));
    await migration.pool.end();
    const module = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = module.createNestApplication();
    app.setGlobalPrefix('api');
    await app.listen(0, '127.0.0.1');
    target = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      response.end('{"status":"ready"}');
    });
    await new Promise<void>((resolveListen) => target.listen(0, '127.0.0.1', resolveListen));
  }, 60_000);

  afterAll(async () => {
    await Promise.all(agents.map(stopAgent));
    await app?.close();
    await new Promise<void>((resolveClose) => target?.close(() => resolveClose()));
    await container?.stop();
    await Promise.all(
      agents.map(({ directory }) => rm(directory, { recursive: true, force: true })),
    );
  });

  it('runs parallel standalone agents and exposes one authoritative aggregate with regional diagnostics', async () => {
    const locationIds: string[] = [];
    for (const slug of ['acceptance-lagos', 'acceptance-frankfurt']) {
      const location = (
        await request(app.getHttpServer())
          .post('/api/probe-locations')
          .send({ name: slug, slug })
          .expect(201)
      ).body.data as { id: string };
      locationIds.push(location.id);
      const enrollment = (
        await request(app.getHttpServer())
          .post(`/api/probe-locations/${location.id}/enrollments`)
          .send({ agentName: `${slug}-agent` })
          .expect(201)
      ).body.data as { id: string; token: string };
      agents.push(await startAgent(enrollment, slug));
    }
    const targetAddress = target.address() as AddressInfo;
    const monitor = (
      await request(app.getHttpServer())
        .post('/api/monitors')
        .send({
          name: 'Multi-location acceptance',
          url: `http://acceptance.test:${targetAddress.port}/health`,
        })
        .expect(201)
    ).body.data as { id: string };
    await request(app.getHttpServer())
      .patch(`/api/monitors/${monitor.id}/locations`)
      .send({ locations: locationIds })
      .expect(200);
    const round = (
      await request(app.getHttpServer())
        .post(`/api/monitors/${monitor.id}/check-rounds`)
        .expect(202)
    ).body.data as { id: string };

    const detail = await waitForRound(monitor.id, round.id);
    expect(detail).toMatchObject({
      status: 'COMPLETED',
      result: {
        kind: 'MULTI_LOCATION',
        outcome: 'UP',
        counts: { selected: 2, pass: 2, confirmedFail: 0, unknown: 0 },
        coverage: { numerator: 2, denominator: 2 },
        reachability: { numerator: 2, denominator: 2 },
        regions: [
          {
            outcome: 'PASS',
            executions: [{ role: 'PRIMARY', diagnosticSummary: { statusCode: 200 } }],
          },
          {
            outcome: 'PASS',
            executions: [{ role: 'PRIMARY', diagnosticSummary: { statusCode: 200 } }],
          },
        ],
      },
    });
    const history = await request(app.getHttpServer())
      .get(`/api/monitors/${monitor.id}/check-rounds`)
      .expect(200);
    expect(history.body.data).toHaveLength(1);
    expect(history.body.data[0]).toMatchObject({
      id: round.id,
      result: { kind: 'MULTI_LOCATION', outcome: 'UP' },
    });
  }, 60_000);

  async function startAgent(
    enrollment: { id: string; token: string },
    suffix: string,
  ): Promise<AgentProcess> {
    const address = app.getHttpServer().address() as AddressInfo;
    const directory = await mkdtemp(resolve(tmpdir(), `watchrail-slice11-${suffix}-`));
    const state: AgentProcess = {
      child: undefined as unknown as ChildProcess,
      output: '',
      directory,
    };
    state.child = spawn(
      process.execPath,
      [resolve(process.cwd(), '../../tooling/probe-agent-acceptance-process.mjs')],
      {
        cwd: directory,
        env: {
          NODE_ENV: 'test',
          PROBE_COORDINATOR_URL: `http://127.0.0.1:${address.port}`,
          PROBE_ENROLLMENT_ID: enrollment.id,
          PROBE_ENROLLMENT_TOKEN: enrollment.token,
          PROBE_CREDENTIAL_FILE: resolve(directory, 'credential'),
          PROBE_POLL_INTERVAL_MS: '1000',
          PROBE_HEARTBEAT_INTERVAL_MS: '5000',
          PROBE_RENEWAL_INTERVAL_MS: '5000',
          PROBE_COORDINATOR_REQUEST_TIMEOUT_MS: '3000',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    state.child.stdout?.on('data', (chunk: Buffer) => (state.output += chunk.toString('utf8')));
    state.child.stderr?.on('data', (chunk: Buffer) => (state.output += chunk.toString('utf8')));
    return state;
  }

  async function stopAgent(agent: AgentProcess): Promise<void> {
    if (agent.child.exitCode !== null) return;
    const stopped = new Promise<void>((resolveExit) =>
      agent.child.once('exit', () => resolveExit()),
    );
    agent.child.kill('SIGTERM');
    await Promise.race([
      stopped,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`Probe agent did not stop. ${agent.output}`)), 5_000),
      ),
    ]);
  }

  async function waitForRound(
    monitorId: string,
    roundId: string,
  ): Promise<Record<string, unknown>> {
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      const response = await request(app.getHttpServer()).get(
        `/api/monitors/${monitorId}/check-rounds/${roundId}`,
      );
      if (response.status === 200 && response.body.data?.status === 'COMPLETED') {
        return response.body.data as Record<string, unknown>;
      }
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
    }
    throw new Error(
      `Timed out waiting for round ${roundId}. ${agents.map(({ output }) => output).join('\n')}`,
    );
  }
});
