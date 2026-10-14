import 'reflect-metadata';
import { createHash, randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { getDrizzleToken } from '@nestjs/drizzle';
import { Test } from '@nestjs/testing';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import {
  createDatabaseConnection,
  migrateDatabase,
  ProbeIdentityRepository,
  type DatabaseConnection,
  type WatchrailDatabase,
} from '@watchrail/db';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';

const organizationB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const developmentOrganizationId = '00000000-0000-4000-8000-000000000002';
interface LocationResponse {
  id: string;
}
interface EnrollmentResponse {
  id: string;
  token: string;
}

describe('probe enrollment and machine credentials API', () => {
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
    await app.init();
  }, 60_000);

  beforeEach(async () => {
    await database.$client.query('truncate probe_locations cascade');
  });

  afterAll(async () => {
    await app?.close();
    await container?.stop();
  });

  it('enrolls, authenticates, rotates, lists safely, and revokes an agent', async () => {
    const location = await createLocation('frankfurt');
    const issued = await issueEnrollment(location.id, 'fra-agent-1');
    expect(issued.token).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    const enrolled = (
      await request(app.getHttpServer())
        .post('/api/probe-machine/enroll')
        .send({ enrollmentId: issued.id, token: issued.token })
        .expect('Cache-Control', 'no-store')
        .expect(201)
    ).body.data;
    expect(enrolled).toMatchObject({ locationId: location.id, credentialVersion: 1 });
    expect(enrolled.credential).toMatch(/^[A-Za-z0-9_-]{43}$/u);

    const me = (
      await request(app.getHttpServer())
        .get('/api/probe-machine/me')
        .set('Authorization', `Bearer ${enrolled.credential}`)
        .expect('Cache-Control', 'no-store')
        .expect(200)
    ).body.data;
    expect(me).toMatchObject({ agentId: enrolled.agentId, locationId: location.id });

    const rotated = (
      await request(app.getHttpServer())
        .post('/api/probe-machine/credentials/rotate')
        .set('Authorization', `Bearer ${enrolled.credential}`)
        .send({})
        .expect('Cache-Control', 'no-store')
        .expect(201)
    ).body.data;
    expect(rotated).toMatchObject({ agentId: enrolled.agentId, credentialVersion: 2 });
    expect(rotated.credential).not.toBe(enrolled.credential);
    await machineMe(enrolled.credential, 401);
    await machineMe(rotated.credential, 200);

    const stored = await database.$client.query<{
      verifier: string;
      status: string;
    }>('select verifier, status from probe_agent_credentials order by version_number');
    expect(stored.rows.map(({ status }) => status)).toEqual(['REVOKED', 'ACTIVE']);
    expect(JSON.stringify(stored.rows)).not.toContain(enrolled.credential);
    expect(JSON.stringify(stored.rows)).not.toContain(rotated.credential);

    const agents = (await request(app.getHttpServer()).get('/api/probe-agents').expect(200)).body
      .data;
    expect(agents).toHaveLength(1);
    expect(JSON.stringify(agents)).not.toContain(issued.token);
    expect(JSON.stringify(agents)).not.toContain(enrolled.credential);
    expect(JSON.stringify(agents)).not.toContain(rotated.credential);

    await request(app.getHttpServer())
      .patch(`/api/probe-locations/${location.id}/status`)
      .send({ status: 'DISABLED' })
      .expect(200);
    await machineMe(rotated.credential, 401);
    await request(app.getHttpServer())
      .patch(`/api/probe-locations/${location.id}/status`)
      .send({ status: 'ACTIVE' })
      .expect(200);
    await machineMe(rotated.credential, 200);

    await request(app.getHttpServer())
      .post(`/api/probe-agents/${enrolled.agentId}/revoke`)
      .send({})
      .expect(204);
    await machineMe(rotated.credential, 401);
  });

  it('redeems an enrollment at most once under concurrency', async () => {
    const location = await createLocation('lagos');
    const issued = await issueEnrollment(location.id, 'lagos-agent');
    const responses = await Promise.all([
      request(app.getHttpServer())
        .post('/api/probe-machine/enroll')
        .send({ enrollmentId: issued.id, token: issued.token }),
      request(app.getHttpServer())
        .post('/api/probe-machine/enroll')
        .send({ enrollmentId: issued.id, token: issued.token }),
    ]);
    expect(responses.map(({ status }) => status).sort()).toEqual([201, 401]);
    expect((await database.$client.query('select id from probe_agents')).rows).toHaveLength(1);
    expect(
      (await database.$client.query('select id from probe_agent_credentials')).rows,
    ).toHaveLength(1);
  });

  it('serializes credential rotation before agent revocation without leaving an active credential', async () => {
    const location = await createLocation('rotation-revocation-race');
    const issued = await issueEnrollment(location.id, 'racing-agent');
    const enrolled = (
      await request(app.getHttpServer())
        .post('/api/probe-machine/enroll')
        .send({ enrollmentId: issued.id, token: issued.token })
        .expect(201)
    ).body.data as {
      agentId: string;
      credential: string;
      credentialVersion: number;
      locationId: string;
    };
    const credential = await database.$client.query<{ id: string }>(
      `select id from probe_agent_credentials where agent_id = $1 and status = 'ACTIVE'`,
      [enrolled.agentId],
    );
    const blocker = createNamedConnection('probe-agent-lock-blocker');
    const rotation = createNamedConnection('probe-agent-rotation');
    const revocation = createNamedConnection('probe-agent-revocation');

    try {
      await blocker.pool.query('begin');
      await blocker.pool.query('select id from probe_agents where id = $1 for update', [
        enrolled.agentId,
      ]);

      const rotationPromise = new ProbeIdentityRepository(rotation.db).rotateCredential(
        {
          agentId: enrolled.agentId,
          organizationId: developmentOrganizationId,
          locationId: enrolled.locationId,
          credentialId: credential.rows[0]!.id,
          credentialVersion: enrolled.credentialVersion,
        },
        createHash('sha256').update(randomBytes(32)).digest('base64url'),
      );
      await waitForApplicationLock('probe-agent-rotation');

      const revocationPromise = new ProbeIdentityRepository(revocation.db).revokeAgent(
        developmentOrganizationId,
        enrolled.agentId,
      );
      await waitForApplicationLock('probe-agent-revocation');
      await blocker.pool.query('commit');

      await rotationPromise;
      await revocationPromise;
    } finally {
      await blocker.pool.query('rollback').catch(() => undefined);
      await Promise.all([blocker.pool.end(), rotation.pool.end(), revocation.pool.end()]);
    }

    const agent = await database.$client.query<{ status: string }>(
      'select status from probe_agents where id = $1',
      [enrolled.agentId],
    );
    const credentials = await database.$client.query<{ status: string }>(
      'select status from probe_agent_credentials where agent_id = $1 order by version_number',
      [enrolled.agentId],
    );
    expect(agent.rows[0]?.status).toBe('REVOKED');
    expect(credentials.rows.map(({ status }) => status)).toEqual(['REVOKED', 'REVOKED']);
  }, 15_000);

  it('rejects expired, revoked, disabled, and cross-organization enrollment operations', async () => {
    const location = await createLocation('virginia');
    const expired = await issueEnrollment(location.id, 'expired-agent');
    await database.$client.query(
      `update probe_agent_enrollments
          set created_at = clock_timestamp() - interval '20 minutes',
              expires_at = clock_timestamp() - interval '1 second'
        where id = $1`,
      [expired.id],
    );
    await enrollFails(expired);

    const revoked = await issueEnrollment(location.id, 'revoked-agent');
    await request(app.getHttpServer())
      .post(`/api/probe-enrollments/${revoked.id}/revoke`)
      .send({})
      .expect(204);
    await enrollFails(revoked);

    const disabled = await issueEnrollment(location.id, 'disabled-agent');
    await request(app.getHttpServer())
      .patch(`/api/probe-locations/${location.id}/status`)
      .send({ status: 'DISABLED' })
      .expect(200);
    await enrollFails(disabled);
    await request(app.getHttpServer())
      .post(`/api/probe-locations/${location.id}/enrollments`)
      .send({ agentName: 'new-agent' })
      .expect(409);

    const foreign = await database.$client.query<{ id: string }>(
      `insert into probe_locations (organization_id, name, slug)
       values ($1, 'Foreign', 'foreign') returning id`,
      [organizationB],
    );
    await request(app.getHttpServer())
      .post(`/api/probe-locations/${foreign.rows[0]!.id}/enrollments`)
      .send({ agentName: 'foreign-agent' })
      .expect(404);
  });

  it('claims, resolves configuration, heartbeats, and submits fenced remote work through the machine API', async () => {
    const location = await createLocation('coordinator-api');
    const issued = await issueEnrollment(location.id, 'coordinator-agent');
    const enrolled = (
      await request(app.getHttpServer())
        .post('/api/probe-machine/enroll')
        .send({ enrollmentId: issued.id, token: issued.token })
        .expect(201)
    ).body.data as { credential: string };
    const monitor = (
      await request(app.getHttpServer())
        .post('/api/monitors')
        .send({ name: 'Remote API', url: 'https://example.com/health' })
        .expect(201)
    ).body.data as { id: string };
    const sentinel = 'WATCHRAIL_REMOTE_CONFIGURATION_SECRET';
    await request(app.getHttpServer())
      .patch(`/api/monitors/${monitor.id}/request-headers`)
      .send({
        requestHeaders: [{ name: 'authorization', sensitive: true, value: `Bearer ${sentinel}` }],
      })
      .expect(200);
    const round = (
      await request(app.getHttpServer())
        .post(`/api/monitors/${monitor.id}/check-rounds`)
        .expect(202)
    ).body.data as { id: string };
    await database.$client.query(
      `update check_execution_assignments
          set location=$1::text, probe_location_id=$1::uuid
        where round_id=$2`,
      [location.id, round.id],
    );

    const heartbeat = await machinePost(enrolled.credential, '/api/probe-machine/heartbeat')
      .send({ contractVersion: 1, engineVersion: 'watchrail-http-v1' })
      .expect(201);
    expect(new Date(heartbeat.body.data.receivedAt).toISOString()).toBe(
      heartbeat.body.data.receivedAt,
    );

    const claimed = await machinePost(enrolled.credential, '/api/probe-machine/leases/claim')
      .send({ contractVersion: 1, engineVersion: 'watchrail-http-v1' })
      .expect(201);
    const lease = claimed.body.data as {
      assignmentId: string;
      attemptId: string;
      attemptNumber: number;
      claimToken: string;
    };
    const reference = {
      contractVersion: 1,
      assignmentId: lease.assignmentId,
      attemptId: lease.attemptId,
      attemptNumber: lease.attemptNumber,
      engineVersion: 'watchrail-http-v1',
    };
    const executionConfiguration = await request(app.getHttpServer())
      .get(`/api/probe-machine/leases/${lease.attemptId}/configuration`)
      .set('Authorization', `Bearer ${enrolled.credential}`)
      .set('X-Watchrail-Claim-Token', lease.claimToken)
      .expect('Cache-Control', 'no-store')
      .expect(200);
    expect(executionConfiguration.body.data).toMatchObject({
      contractVersion: 1,
      assignmentId: lease.assignmentId,
      attemptId: lease.attemptId,
      url: 'https://example.com/health',
      method: 'GET',
      requestHeaders: [{ name: 'authorization', value: `Bearer ${sentinel}` }],
      assertions: { headers: [], textBody: [], jsonBody: [] },
    });
    expect(JSON.stringify(executionConfiguration.body)).not.toMatch(
      /encryptedValue|ciphertext|authTag|keyId/u,
    );
    const result = {
      outcome: 'PASS',
      stage: 'HTTP',
      reason: 'COMPLETED',
      statusCode: 200,
      responseTimeMs: 20,
      attemptDurationMs: 25,
      redirects: [],
      assertionEvaluation: { contractVersion: 1, outcome: 'PASS', diagnostics: [] },
      checkedAt: new Date().toISOString(),
    };
    await machinePost(enrolled.credential, `/api/probe-machine/leases/${lease.attemptId}/results`)
      .set('X-Watchrail-Claim-Token', lease.claimToken)
      .send({ reference, result })
      .expect(201)
      .expect(({ body }) => expect(body.data).toEqual({ state: 'ACCEPTED', duplicate: false }));
    await machinePost(enrolled.credential, `/api/probe-machine/leases/${lease.attemptId}/results`)
      .set('X-Watchrail-Claim-Token', lease.claimToken)
      .send({ reference, result })
      .expect(201)
      .expect(({ body }) => expect(body.data).toEqual({ state: 'ACCEPTED', duplicate: true }));
  });

  async function createLocation(slug: string): Promise<LocationResponse> {
    return (
      await request(app.getHttpServer())
        .post('/api/probe-locations')
        .send({ name: slug, slug })
        .expect(201)
    ).body.data as LocationResponse;
  }

  async function issueEnrollment(
    locationId: string,
    agentName: string,
  ): Promise<EnrollmentResponse> {
    return (
      await request(app.getHttpServer())
        .post(`/api/probe-locations/${locationId}/enrollments`)
        .send({ agentName })
        .expect('Cache-Control', 'no-store')
        .expect(201)
    ).body.data as EnrollmentResponse;
  }

  async function machineMe(credential: string, status: number): Promise<void> {
    await request(app.getHttpServer())
      .get('/api/probe-machine/me')
      .set('Authorization', `Bearer ${credential}`)
      .expect('Cache-Control', 'no-store')
      .expect(status);
  }

  function machinePost(credential: string, path: string) {
    return request(app.getHttpServer()).post(path).set('Authorization', `Bearer ${credential}`);
  }

  async function enrollFails(input: { id: string; token: string }): Promise<void> {
    const response = await request(app.getHttpServer())
      .post('/api/probe-machine/enroll')
      .send({ enrollmentId: input.id, token: input.token })
      .expect('Cache-Control', 'no-store')
      .expect(401);
    expect(response.body).toEqual({
      code: 'PROBE_AUTHENTICATION_FAILED',
      message: 'Probe authentication failed.',
    });
  }

  function createNamedConnection(applicationName: string): DatabaseConnection {
    const uri = new URL(container.getConnectionUri());
    uri.searchParams.set('application_name', applicationName);
    return createDatabaseConnection(uri.toString());
  }

  async function waitForApplicationLock(applicationName: string): Promise<void> {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const result = await database.$client.query<{ waiting: boolean }>(
        `select exists (
           select 1
           from pg_stat_activity
           where application_name = $1
             and wait_event_type = 'Lock'
         ) as waiting`,
        [applicationName],
      );
      if (result.rows[0]?.waiting === true) return;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
    }
    throw new Error(`Timed out waiting for ${applicationName} to block on the agent lock.`);
  }
});
