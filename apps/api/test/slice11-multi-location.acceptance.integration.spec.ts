import 'reflect-metadata';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import {
  createDatabaseConnection,
  migrateDatabase,
  MultiLocationRoundFinalizationRepository,
  ScheduledRoundRepository,
  type DatabaseConnection,
} from '@watchrail/db';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { ProbeMachineRateLimiter } from '../src/probe-machine-auth.js';

interface AgentProcess {
  child: ChildProcess;
  output: string;
  directory: string;
  captureFile: string;
}

type TargetMode = 'HEALTHY' | 'LAGOS_DOWN' | 'ALL_DOWN';

describe('Slice 11 multi-location acceptance', () => {
  let app: INestApplication;
  let container: StartedPostgreSqlContainer;
  let target: Server;
  let database: DatabaseConnection;
  let targetMode: TargetMode = 'HEALTHY';
  const agents: AgentProcess[] = [];
  const organizationId = '00000000-0000-4000-8000-000000000002';

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
    database = createDatabaseConnection(container.getConnectionUri());
    await migrateDatabase(database, resolve(process.cwd(), '../../packages/db/drizzle'));
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(ProbeMachineRateLimiter)
      .useValue({ consume: () => ({ allowed: true }) })
      .compile();
    app = module.createNestApplication();
    app.setGlobalPrefix('api');
    await app.listen(0, '127.0.0.1');
    target = createServer((incoming, response) => {
      const location = incoming.headers['x-watchrail-acceptance-location'];
      const fails =
        targetMode === 'ALL_DOWN' || (targetMode === 'LAGOS_DOWN' && location === 'lagos');
      response.writeHead(fails ? 503 : 200, {
        'content-type': 'application/json; charset=utf-8',
      });
      response.end(fails ? '{"status":"down"}' : '{"status":"ready"}');
    });
    await new Promise<void>((resolveListen) => target.listen(0, '127.0.0.1', resolveListen));
  }, 60_000);

  afterAll(async () => {
    await Promise.all(agents.map(stopAgent));
    await app?.close();
    await database?.pool.end();
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

  it('proves scheduled degradation, outage, recovery, replay protection and deadline fencing', async () => {
    targetMode = 'HEALTHY';
    const locationIds: string[] = [];
    const releaseAgents: AgentProcess[] = [];
    for (const locationName of ['lagos', 'frankfurt']) {
      const location = (
        await request(app.getHttpServer())
          .post('/api/probe-locations')
          .send({ name: `release-${locationName}`, slug: `release-${locationName}` })
          .expect(201)
      ).body.data as { id: string };
      locationIds.push(location.id);
      for (let agentIndex = 1; agentIndex <= 2; agentIndex += 1) {
        const enrollment = (
          await request(app.getHttpServer())
            .post(`/api/probe-locations/${location.id}/enrollments`)
            .send({ agentName: `${locationName}-agent-${agentIndex}` })
            .expect(201)
        ).body.data as { id: string; token: string };
        const agent = await startAgent(enrollment, `${locationName}-${agentIndex}`, {
          location: locationName,
        });
        releaseAgents.push(agent);
        agents.push(agent);
      }
    }
    await request(app.getHttpServer())
      .post('/api/webhook-endpoints')
      .send({
        name: 'Release acceptance webhook',
        url: 'https://hooks.example.com/release-acceptance',
        signingSecret: 'release-acceptance-signing-secret',
        enabled: true,
      })
      .expect(201);
    const targetAddress = target.address() as AddressInfo;
    const monitor = (
      await request(app.getHttpServer())
        .post('/api/monitors')
        .send({
          name: 'Multi-location release acceptance',
          url: `http://acceptance.test:${targetAddress.port}/health`,
        })
        .expect(201)
    ).body.data as { id: string };
    await request(app.getHttpServer())
      .patch(`/api/monitors/${monitor.id}/locations`)
      .send({ locations: locationIds })
      .expect(200);
    await waitForHealthyAgents(locationIds, 4);

    const baseline = await dispatchScheduledRound(monitor.id);
    expect((await waitForRound(monitor.id, baseline.id)).result).toMatchObject({ outcome: 'UP' });
    await expectIncidentState(monitor.id, null, 0);
    await expectAvailability(monitor.id, 'AVAILABLE');

    targetMode = 'LAGOS_DOWN';
    const degraded = await dispatchScheduledRound(monitor.id);
    const degradedDetail = await waitForRound(monitor.id, degraded.id);
    expect(degradedDetail.result).toMatchObject({
      outcome: 'DEGRADED',
      regions: expect.arrayContaining([
        expect.objectContaining({
          outcome: 'CONFIRMED_FAIL',
          executions: expect.arrayContaining([
            expect.objectContaining({
              role: 'PRIMARY',
              diagnosticSummary: expect.objectContaining({ statusCode: 503 }),
            }),
            expect.objectContaining({
              role: 'CONFIRMATION',
              diagnosticSummary: expect.objectContaining({ statusCode: 503 }),
            }),
          ]),
        }),
        expect.objectContaining({ outcome: 'PASS' }),
      ]),
    });
    const failedRegionExecutions = await database.pool.query<{
      agent_id: string;
      role: 'PRIMARY' | 'CONFIRMATION';
    }>(
      `select agent_id, role
       from check_regional_executions
       where round_id = $1 and location = $2
       order by role`,
      [degraded.id, locationIds[0]],
    );
    expect(failedRegionExecutions.rows.map(({ role }) => role).sort()).toEqual([
      'CONFIRMATION',
      'PRIMARY',
    ]);
    expect(new Set(failedRegionExecutions.rows.map(({ agent_id }) => agent_id)).size).toBe(2);
    const incidentId = await expectIncidentState(monitor.id, 'DEGRADED', 0);
    if (!incidentId) throw new Error('Expected the degraded round to open an incident.');
    await expectAvailability(monitor.id, 'UNAVAILABLE');
    await expectNotificationState(incidentId, ['INCIDENT_OPENED']);

    targetMode = 'ALL_DOWN';
    const down = await dispatchScheduledRound(monitor.id);
    expect((await waitForRound(monitor.id, down.id)).result).toMatchObject({
      outcome: 'DOWN',
      counts: { confirmedFail: 2 },
    });
    expect(await expectIncidentState(monitor.id, 'DOWN', 0)).toBe(incidentId);
    await expectAvailability(monitor.id, 'UNAVAILABLE');
    await expectNotificationState(incidentId, ['INCIDENT_OPENED']);

    targetMode = 'HEALTHY';
    const firstRecovery = await dispatchScheduledRound(monitor.id);
    expect((await waitForRound(monitor.id, firstRecovery.id)).result).toMatchObject({
      outcome: 'UP',
    });
    expect(await expectIncidentState(monitor.id, 'DOWN', 1)).toBe(incidentId);
    await expectAvailability(monitor.id, 'AVAILABLE');

    const secondRecovery = await dispatchScheduledRound(monitor.id);
    expect((await waitForRound(monitor.id, secondRecovery.id)).result).toMatchObject({
      outcome: 'UP',
    });
    await expectIncidentState(monitor.id, null, 0, incidentId);
    await expectAvailability(monitor.id, 'AVAILABLE');
    await expectNotificationState(incidentId, ['INCIDENT_OPENED', 'INCIDENT_RESOLVED']);

    const captured = await capturedSubmission(secondRecovery.id);
    const beforeReplay = await durableRoundState(secondRecovery.id, incidentId);
    const replay = await submitCaptured(captured, JSON.parse(captured.body));
    expect(replay.status).toBe(201);
    expect(replay.body.data).toMatchObject({ duplicate: true });
    const changed = JSON.parse(captured.body) as { result: { attemptDurationMs: number } };
    changed.result.attemptDurationMs += 1;
    await submitCaptured(captured, changed).expect(409);
    expect(await durableRoundState(secondRecovery.id, incidentId)).toEqual(beforeReplay);

    const revokedReplay = {
      ...captured,
      claimToken: `${captured.claimToken.slice(0, -1)}${captured.claimToken.endsWith('A') ? 'B' : 'A'}`,
    };
    await submitCaptured(revokedReplay, JSON.parse(captured.body)).expect(409);
    expect(await durableRoundState(secondRecovery.id, incidentId)).toEqual(beforeReplay);

    await Promise.all(releaseAgents.map(stopAgent));
    const delayedEnrollment = (
      await request(app.getHttpServer())
        .post(`/api/probe-locations/${locationIds[0]}/enrollments`)
        .send({ agentName: 'deadline-fencing-agent' })
        .expect(201)
    ).body.data as { id: string; token: string };
    const delayedAgent = await startAgent(delayedEnrollment, 'deadline-fencing', {
      location: 'lagos',
      submissionDelayMs: 4_000,
      coordinatorRequestTimeoutMs: 10_000,
    });
    agents.push(delayedAgent);

    const deadlineRound = await dispatchScheduledRound(monitor.id);
    const lateSubmission = await waitForCapturedSubmission(deadlineRound.id);
    await database.pool.query(
      `update check_rounds
       set finalization_deadline_at = created_at + interval '1 millisecond'
       where id = $1`,
      [deadlineRound.id],
    );
    const finalization = await new MultiLocationRoundFinalizationRepository(
      database.db,
    ).tryFinalizeRound(organizationId, deadlineRound.id);
    expect(finalization).toMatchObject({
      state: 'FINALIZE',
      cause: 'DEADLINE_REACHED',
      aggregate: { outcome: 'UNKNOWN' },
    });
    expect((await waitForRound(monitor.id, deadlineRound.id)).result).toMatchObject({
      outcome: 'UNKNOWN',
    });

    const fencedState = await durableRoundState(deadlineRound.id, incidentId);
    await waitForCapturedResponse(delayedAgent, lateSubmission.url, 409);
    expect(await durableRoundState(deadlineRound.id, incidentId)).toEqual(fencedState);
    const fencedAttempts = await database.pool.query<{ status: string }>(
      `select a.status
       from probe_execution_attempts a
       inner join check_execution_assignments x on x.id = a.assignment_id
       where x.round_id = $1`,
      [deadlineRound.id],
    );
    expect(fencedAttempts.rows).not.toHaveLength(0);
    expect(fencedAttempts.rows.every(({ status }) => status !== 'SUBMITTED')).toBe(true);
  }, 120_000);

  async function startAgent(
    enrollment: { id: string; token: string },
    suffix: string,
    options: {
      location?: string;
      submissionDelayMs?: number;
      coordinatorRequestTimeoutMs?: number;
    } = {},
  ): Promise<AgentProcess> {
    const address = app.getHttpServer().address() as AddressInfo;
    const directory = await mkdtemp(resolve(tmpdir(), `watchrail-slice11-${suffix}-`));
    const captureFile = resolve(directory, 'submissions.jsonl');
    const state: AgentProcess = {
      child: undefined as unknown as ChildProcess,
      output: '',
      directory,
      captureFile,
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
          PROBE_COORDINATOR_REQUEST_TIMEOUT_MS: String(
            options.coordinatorRequestTimeoutMs ?? 3_000,
          ),
          PROBE_ACCEPTANCE_SUBMISSION_CAPTURE_FILE: captureFile,
          ...(options.location ? { PROBE_ACCEPTANCE_LOCATION: options.location } : {}),
          ...(options.submissionDelayMs
            ? { PROBE_ACCEPTANCE_SUBMISSION_DELAY_MS: String(options.submissionDelayMs) }
            : {}),
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
    const deadline = Date.now() + 30_000;
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

  async function waitForHealthyAgents(locationIds: string[], expectedCount: number): Promise<void> {
    const deadline = Date.now() + 20_000;
    let observed: Array<{ location_id: string; status: string; last_heartbeat_at: Date | null }> =
      [];
    while (Date.now() < deadline) {
      const result = await database.pool.query<{
        location_id: string;
        status: string;
        last_heartbeat_at: Date | null;
      }>(
        `select location_id, status, last_heartbeat_at
         from probe_agents
         where location_id = any($1::uuid[])
         order by location_id, created_at`,
        [locationIds],
      );
      observed = result.rows;
      if (
        observed.filter(
          ({ status, last_heartbeat_at }) => status === 'ACTIVE' && last_heartbeat_at !== null,
        ).length === expectedCount
      ) {
        return;
      }
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
    }
    throw new Error(
      `Timed out waiting for ${expectedCount} healthy acceptance agents. Observed: ${JSON.stringify(observed)}\n${agents.map(({ output }) => output).join('\n')}`,
    );
  }

  async function dispatchScheduledRound(monitorId: string): Promise<{ id: string }> {
    await database.pool.query(
      `update monitors
       set next_check_at = clock_timestamp() - interval '1 second'
       where id = $1`,
      [monitorId],
    );
    const rounds = await new ScheduledRoundRepository(database.db, true).dispatchDue(1);
    const round = rounds.find((candidate) => candidate.monitorId === monitorId);
    if (!round) throw new Error(`Scheduled round was not dispatched for ${monitorId}.`);
    return round;
  }

  async function expectIncidentState(
    monitorId: string,
    severity: 'DEGRADED' | 'DOWN' | null,
    recoveryStreak: number,
    resolvedIncidentId?: string,
  ): Promise<string | null> {
    const state = await database.pool.query<{
      incident_id: string | null;
      incident_status: 'OPEN' | 'RESOLVED' | null;
      incident_severity: 'DEGRADED' | 'DOWN' | null;
      state_severity: 'DEGRADED' | 'DOWN' | null;
      recovery_streak: number;
    }>(
      `select i.id as incident_id,
              i.status as incident_status,
              i.severity as incident_severity,
              s.multi_location_severity as state_severity,
              s.multi_location_healthy_recovery_streak as recovery_streak
       from monitor_incident_state s
       left join incidents i
         on i.organization_id = s.organization_id
        and i.monitor_id = s.monitor_id
        and ($2::uuid is null or i.id = $2::uuid)
       where s.monitor_id = $1
       order by i.created_at desc nulls last
       limit 1`,
      [monitorId, resolvedIncidentId ?? null],
    );
    const row = state.rows[0]!;
    expect(row.state_severity).toBe(severity);
    expect(row.recovery_streak).toBe(recoveryStreak);
    if (severity === null && resolvedIncidentId) {
      expect(row).toMatchObject({
        incident_id: resolvedIncidentId,
        incident_status: 'RESOLVED',
      });
    } else if (severity !== null) {
      expect(row).toMatchObject({ incident_status: 'OPEN', incident_severity: severity });
    } else {
      expect(row.incident_id).toBeNull();
    }
    return row.incident_id;
  }

  async function expectNotificationState(
    incidentId: string,
    eventTypes: Array<'INCIDENT_OPENED' | 'INCIDENT_RESOLVED'>,
  ): Promise<void> {
    const events = await database.pool.query<{ event_type: string }>(
      `select event_type
       from notification_events
       where incident_id = $1
       order by created_at, id`,
      [incidentId],
    );
    expect(events.rows.map(({ event_type }) => event_type)).toEqual(eventTypes);
    const deliveries = await database.pool.query<{ event_id: string }>(
      `select d.event_id
       from notification_deliveries d
       inner join notification_events e on e.id = d.event_id
       where e.incident_id = $1`,
      [incidentId],
    );
    expect(deliveries.rows).toHaveLength(eventTypes.length);
  }

  async function expectAvailability(
    monitorId: string,
    expected: 'AVAILABLE' | 'UNAVAILABLE' | 'UNKNOWN',
  ): Promise<void> {
    const state = await database.pool.query<{ current_state: string }>(
      'select current_state from monitor_availability_state where monitor_id = $1',
      [monitorId],
    );
    expect(state.rows[0]?.current_state).toBe(expected);
  }

  interface CapturedSubmission {
    kind: 'request';
    url: string;
    authorization: string;
    claimToken: string;
    body: string;
  }

  interface CapturedSubmissionResponse {
    kind: 'response';
    url: string;
    status: number;
  }

  async function capturedSubmission(roundId: string): Promise<CapturedSubmission> {
    const attempts = await database.pool.query<{ id: string }>(
      `select a.id
       from probe_execution_attempts a
       inner join check_execution_assignments x on x.id = a.assignment_id
       where x.round_id = $1`,
      [roundId],
    );
    const attemptIds = new Set(attempts.rows.map(({ id }) => id));
    for (const agent of agents) {
      let content = '';
      try {
        content = await readFile(agent.captureFile, 'utf8');
      } catch {
        continue;
      }
      for (const line of content.trim().split('\n').reverse()) {
        if (!line) continue;
        const captured = JSON.parse(line) as CapturedSubmission | CapturedSubmissionResponse;
        if (captured.kind !== 'request') continue;
        const attemptId = captured.url.split('/').at(-2);
        if (attemptId && attemptIds.has(attemptId)) return captured;
      }
    }
    throw new Error(`No captured submission found for round ${roundId}.`);
  }

  async function waitForCapturedResponse(
    agent: AgentProcess,
    url: string,
    expectedStatus: number,
  ): Promise<void> {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      try {
        const lines = (await readFile(agent.captureFile, 'utf8')).trim().split('\n');
        const responses = lines
          .filter(Boolean)
          .map((line) => JSON.parse(line) as CapturedSubmission | CapturedSubmissionResponse)
          .filter(
            (entry): entry is CapturedSubmissionResponse =>
              entry.kind === 'response' && entry.url === url,
          );
        if (responses.some(({ status }) => status === expectedStatus)) return;
      } catch {
        // The capture file may not exist until the first submission is attempted.
      }
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
    }
    throw new Error(`Timed out waiting for agent submission response ${expectedStatus}.`);
  }

  async function waitForCapturedSubmission(roundId: string): Promise<CapturedSubmission> {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      try {
        return await capturedSubmission(roundId);
      } catch {
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
      }
    }
    throw new Error(`Timed out waiting for a captured submission for round ${roundId}.`);
  }

  function submitCaptured(captured: CapturedSubmission, body: object) {
    return request(app.getHttpServer())
      .post(new URL(captured.url).pathname)
      .set('authorization', captured.authorization)
      .set('x-watchrail-claim-token', captured.claimToken)
      .send(body);
  }

  async function durableRoundState(roundId: string, incidentId: string) {
    const snapshot = await database.pool.query<{
      aggregate: unknown;
      round_status: string;
      event_count: number;
      delivery_count: number;
      assignments: unknown;
      attempts: unknown;
      regional_evaluations: unknown;
      regional_executions: unknown;
    }>(
      `select
         (select aggregate from check_round_aggregates where round_id = $1) as aggregate,
         (select status from check_rounds where id = $1) as round_status,
         (select count(*)::int from notification_events where incident_id = $2) as event_count,
         (select count(*)::int from notification_deliveries d
            inner join notification_events e on e.id = d.event_id
            where e.incident_id = $2) as delivery_count,
         (select jsonb_agg(jsonb_build_object('id', id, 'status', status) order by id)
            from check_execution_assignments where round_id = $1) as assignments,
         (select jsonb_agg(jsonb_build_object('id', a.id, 'status', a.status) order by a.id)
            from probe_execution_attempts a
            inner join check_execution_assignments x on x.id = a.assignment_id
            where x.round_id = $1) as attempts,
         (select jsonb_agg(to_jsonb(e) - 'updated_at' order by e.location)
            from check_regional_evaluations e where e.round_id = $1) as regional_evaluations,
         (select jsonb_agg(to_jsonb(e) order by e.location, e.role)
            from check_regional_executions e where e.round_id = $1) as regional_executions`,
      [roundId, incidentId],
    );
    return snapshot.rows[0]!;
  }
});
