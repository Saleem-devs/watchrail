import { resolve } from 'node:path';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { createMonitor, EMPTY_ASSERTION_EVALUATION, HTTP_ENGINE_VERSION } from '@watchrail/domain';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDatabaseConnection, type DatabaseConnection } from './client.js';
import type { AuthoritativeCheckResult } from './check-execution-repository.js';
import { ManualRoundRepository } from './manual-round-repository.js';
import { migrateDatabase } from './migration.js';
import { MonitorRepository } from './monitor-repository.js';
import { MultiLocationRoundFinalizationRepository } from './multi-location-finalization-repository.js';
import { ProbeCoordinatorRepository } from './probe-coordinator-repository.js';
import type { ProbeMachineIdentity } from './probe-identity-repository.js';

const organizationId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

describe('probe coordinator repository', () => {
  let container: StartedPostgreSqlContainer;
  let connection: DatabaseConnection;
  let coordinator: ProbeCoordinatorRepository;
  let monitors: MonitorRepository;
  let rounds: ManualRoundRepository;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:18.0-alpine').start();
    connection = createDatabaseConnection(container.getConnectionUri());
    await migrateDatabase(connection, resolve(process.cwd(), 'drizzle'));
    coordinator = new ProbeCoordinatorRepository(connection.db);
    monitors = new MonitorRepository(connection.db);
    rounds = new ManualRoundRepository(connection.db);
  }, 60_000);

  beforeEach(async () => {
    await connection.pool.query('truncate probe_locations, monitors cascade');
  });

  afterAll(async () => {
    await connection?.pool.end();
    await container?.stop();
  });

  it('claims one assignment once across concurrent coordinators and records heartbeat independently', async () => {
    const fixture = await createFixture();
    const claims = await Promise.all([
      coordinator.claim(fixture.machine, HTTP_ENGINE_VERSION),
      coordinator.claim(fixture.machine, HTTP_ENGINE_VERSION),
    ]);
    expect(claims.map(({ state }) => state).sort()).toEqual(['CLAIMED', 'NO_WORK']);
    const claimed = claims.find((claim) => claim.state === 'CLAIMED');
    expect(claimed).toMatchObject({
      lease: {
        assignmentId: fixture.assignmentId,
        attemptNumber: 1,
        requiredEngineVersion: HTTP_ENGINE_VERSION,
      },
    });
    expect(claimed?.state === 'CLAIMED' && claimed.lease.claimToken).toMatch(
      /^[A-Za-z0-9_-]{43}$/u,
    );
    const persisted = await connection.pool.query(
      'select claim_token_verifier from probe_execution_attempts',
    );
    expect(JSON.stringify(persisted.rows)).not.toContain(
      claimed?.state === 'CLAIMED' ? claimed.lease.claimToken : 'impossible',
    );

    const heartbeatAt = await coordinator.heartbeat(fixture.machine, HTTP_ENGINE_VERSION);
    expect(heartbeatAt).toBeInstanceOf(Date);
    const beforeRenewal = claimed?.state === 'CLAIMED' ? claimed.lease.leaseExpiresAt : '';
    const attempt = await connection.pool.query<{ lease_expires_at: Date }>(
      'select lease_expires_at from probe_execution_attempts where assignment_id = $1',
      [fixture.assignmentId],
    );
    expect(attempt.rows[0]!.lease_expires_at.toISOString()).toBe(beforeRenewal);
  });

  it('returns immutable configuration only for the authoritative agent and claim token', async () => {
    const fixture = await createFixture('configuration');
    const lease = await claimLease(fixture.machine);
    await expect(
      coordinator.configuration(fixture.machine, lease.attemptId, lease.claimToken),
    ).resolves.toMatchObject({
      assignmentId: fixture.assignmentId,
      attemptId: lease.attemptId,
      configurationVersionId: lease.configurationVersionId,
      configurationVersionNumber: lease.configurationVersionNumber,
      url: 'https://example.com/health',
      method: 'GET',
      requestHeaders: [],
    });
    await expect(
      coordinator.configuration(fixture.machine, lease.attemptId, 'x'.repeat(43)),
    ).resolves.toBeNull();

    const other = await createFixture('configuration-other-agent');
    await expect(
      coordinator.configuration(other.machine, lease.attemptId, lease.claimToken),
    ).resolves.toBeNull();

    await expire(lease.assignmentId, lease.attemptId);
    await expect(
      coordinator.configuration(fixture.machine, lease.attemptId, lease.claimToken),
    ).resolves.toBeNull();
  });

  it('rejects configuration after the authoritative round deadline before reconciliation', async () => {
    const fixture = await createFixture('configuration-deadline');
    const lease = await claimLease(fixture.machine);
    await connection.pool.query(
      `update check_rounds
       set finalization_deadline_at=clock_timestamp()-interval '1 millisecond'
       where id=(select round_id from check_execution_assignments where id=$1)`,
      [fixture.assignmentId],
    );

    await expect(
      coordinator.configuration(fixture.machine, lease.attemptId, lease.claimToken),
    ).resolves.toBeNull();
  });

  it('expires an old lease and fences stale results after replacement', async () => {
    const fixture = await createFixture();
    const first = await claimLease(fixture.machine);
    await expire(first.assignmentId, first.attemptId);
    const second = await claimLease(fixture.machine);
    expect(second.attemptNumber).toBe(2);
    expect(
      await coordinator.submit(
        fixture.machine,
        resultReference(first),
        first.claimToken,
        passingResult(),
      ),
    ).toEqual({ state: 'REJECTED', reason: 'NON_AUTHORITATIVE_LEASE' });
    expect(
      await coordinator.submit(
        fixture.machine,
        resultReference(second),
        'x'.repeat(43),
        passingResult(),
      ),
    ).toEqual({ state: 'REJECTED', reason: 'CLAIM_TOKEN_MISMATCH' });
  });

  it('renews only the authoritative lease and accepts identical submission replay once', async () => {
    const fixture = await createFixture();
    const lease = await claimLease(fixture.machine);
    const renewed = await coordinator.renew(
      fixture.machine,
      resultReference(lease),
      lease.claimToken,
    );
    expect(renewed?.getTime()).toBeGreaterThanOrEqual(new Date(lease.leaseExpiresAt).getTime());

    expect(
      await coordinator.submit(fixture.machine, resultReference(lease), lease.claimToken, {
        ...passingResult(),
        checkedAt: new Date('2000-01-01T00:00:00.000Z'),
      }),
    ).toEqual({ state: 'REJECTED', reason: 'RESULT_TIMESTAMP_OUT_OF_RANGE' });
    expect(
      await coordinator.submit(fixture.machine, resultReference(lease), lease.claimToken, {
        ...passingResult(),
        checkedAt: new Date(Date.now() + 10 * 60_000),
      }),
    ).toEqual({ state: 'REJECTED', reason: 'RESULT_TIMESTAMP_OUT_OF_RANGE' });

    const result = passingResult();
    expect(
      await coordinator.submit(fixture.machine, resultReference(lease), lease.claimToken, result),
    ).toEqual({
      state: 'ACCEPTED',
      duplicate: false,
    });
    expect(
      await coordinator.submit(fixture.machine, resultReference(lease), lease.claimToken, result),
    ).toEqual({
      state: 'ACCEPTED',
      duplicate: true,
    });
    expect(
      await coordinator.submit(fixture.machine, resultReference(lease), lease.claimToken, {
        ...result,
        attemptDurationMs: 99,
      }),
    ).toEqual({ state: 'REJECTED', reason: 'REPLAY_MISMATCH' });
    expect(
      (await connection.pool.query('select id from check_execution_results')).rows,
    ).toHaveLength(1);
  });

  it('rejects incompatible engines, revoked agents, and disabled locations', async () => {
    const incompatible = await createFixture();
    expect(await coordinator.claim(incompatible.machine, 'other-engine')).toEqual({
      state: 'NO_WORK',
    });

    const revoked = await createFixture('revoked');
    const revokedLease = await claimLease(revoked.machine);
    await connection.pool.query(
      `update probe_agents set status='REVOKED', revoked_at=clock_timestamp() where id=$1`,
      [revoked.machine.agentId],
    );
    await connection.pool.query(
      `update probe_agent_credentials set status='REVOKED', revoked_at=clock_timestamp() where id=$1`,
      [revoked.machine.credentialId],
    );
    await expect(
      coordinator.submit(
        revoked.machine,
        resultReference(revokedLease),
        revokedLease.claimToken,
        passingResult(),
      ),
    ).rejects.toThrow('PROBE_AUTH');

    const disabled = await createFixture('disabled');
    await connection.pool.query(`update probe_locations set status='DISABLED' where id=$1`, [
      disabled.machine.locationId,
    ]);
    await expect(coordinator.claim(disabled.machine, HTTP_ENGINE_VERSION)).rejects.toThrow(
      'PROBE_AUTH',
    );
  });

  it('does not issue a lease when a concurrent location disablement wins the lock', async () => {
    const fixture = await createFixture('disable-claim-race');
    const blocker = createNamedConnection('location-claim-blocker');
    const operator = createNamedConnection('location-claim-operator');
    const claimant = createNamedConnection('location-claim-coordinator');
    try {
      await blocker.pool.query('begin');
      await blocker.pool.query('select id from probe_locations where id=$1 for update', [
        fixture.machine.locationId,
      ]);
      const disable = operator.pool.query(
        `update probe_locations set status='DISABLED', updated_at=clock_timestamp() where id=$1`,
        [fixture.machine.locationId],
      );
      await waitForApplicationLock('location-claim-operator');
      const claim = new ProbeCoordinatorRepository(claimant.db)
        .claim(fixture.machine, HTTP_ENGINE_VERSION)
        .then(
          (value) => ({ value }),
          (error: unknown) => ({ error }),
        );
      await waitForApplicationLock('location-claim-coordinator');
      await blocker.pool.query('commit');
      await disable;
      const outcome = await claim;
      expect(outcome).toHaveProperty('error');
      expect('error' in outcome && outcome.error).toMatchObject({ message: 'PROBE_AUTH' });
    } finally {
      await blocker.pool.query('rollback').catch(() => undefined);
      await Promise.all([blocker.pool.end(), operator.pool.end(), claimant.pool.end()]);
    }
    expect(
      (await connection.pool.query('select id from probe_execution_attempts')).rows,
    ).toHaveLength(0);
  }, 15_000);

  it('does not accept a result when a concurrent location disablement wins the lock', async () => {
    const fixture = await createFixture('disable-submit-race');
    const lease = await claimLease(fixture.machine);
    const blocker = createNamedConnection('location-submit-blocker');
    const operator = createNamedConnection('location-submit-operator');
    const submitter = createNamedConnection('location-submit-coordinator');
    try {
      await blocker.pool.query('begin');
      await blocker.pool.query('select id from probe_locations where id=$1 for update', [
        fixture.machine.locationId,
      ]);
      const disable = operator.pool.query(
        `update probe_locations set status='DISABLED', updated_at=clock_timestamp() where id=$1`,
        [fixture.machine.locationId],
      );
      await waitForApplicationLock('location-submit-operator');
      const submission = new ProbeCoordinatorRepository(submitter.db)
        .submit(fixture.machine, resultReference(lease), lease.claimToken, passingResult())
        .then(
          (value) => ({ value }),
          (error: unknown) => ({ error }),
        );
      await waitForApplicationLock('location-submit-coordinator');
      await blocker.pool.query('commit');
      await disable;
      const outcome = await submission;
      expect(outcome).toHaveProperty('error');
      expect('error' in outcome && outcome.error).toMatchObject({ message: 'PROBE_AUTH' });
    } finally {
      await blocker.pool.query('rollback').catch(() => undefined);
      await Promise.all([blocker.pool.end(), operator.pool.end(), submitter.pool.end()]);
    }
    expect(
      (await connection.pool.query('select id from check_execution_results')).rows,
    ).toHaveLength(0);
  }, 15_000);

  it('finalizes exhausted missing observations as monitoring UNKNOWN without incident failure', async () => {
    const fixture = await createFixture('exhausted', true);
    const lease = await claimLease(fixture.machine);
    await connection.pool.query(
      `update check_execution_assignments
          set attempt_count=3, claim_expires_at=clock_timestamp()-interval '1 second'
        where id=$1`,
      [fixture.assignmentId],
    );
    await connection.pool.query(
      `update probe_execution_attempts
          set attempt_number=3,
              leased_at=clock_timestamp()-interval '2 seconds',
              lease_expires_at=clock_timestamp()-interval '1 second'
        where id=$1`,
      [lease.attemptId],
    );
    expect(await coordinator.reconcileExpired(100)).toBe(1);
    const result = await connection.pool.query<{ outcome: string; stage: string; reason: string }>(
      'select outcome, stage, reason from check_execution_results where assignment_id=$1',
      [fixture.assignmentId],
    );
    expect(result.rows).toEqual([{ outcome: 'UNKNOWN', stage: 'PROBE', reason: 'INTERNAL_ERROR' }]);
    const incidents = await connection.pool.query('select id from incidents');
    expect(incidents.rows).toHaveLength(0);
  });

  it('abandons unclaimed remote assignments after the configured pending deadline', async () => {
    const fixture = await createFixture('unclaimed', true);
    await connection.pool.query(
      `update check_execution_assignments
          set pending_since=clock_timestamp()-interval '11 seconds'
        where id=$1`,
      [fixture.assignmentId],
    );

    expect(await coordinator.reconcileExpired(100, 10_000)).toBe(1);
    const result = await connection.pool.query<{ outcome: string; stage: string; reason: string }>(
      'select outcome, stage, reason from check_execution_results where assignment_id=$1',
      [fixture.assignmentId],
    );
    expect(result.rows).toEqual([{ outcome: 'UNKNOWN', stage: 'PROBE', reason: 'INTERNAL_ERROR' }]);
    expect((await connection.pool.query('select id from incidents')).rows).toHaveLength(0);
  });

  it('does not lease an assignment after its pending deadline, even before reconciliation', async () => {
    const fixture = await createFixture('late-first-claim');
    await connection.pool.query(
      `update check_execution_assignments
          set pending_since=clock_timestamp()-interval '11 seconds'
        where id=$1`,
      [fixture.assignmentId],
    );

    await expect(coordinator.claim(fixture.machine, HTTP_ENGINE_VERSION, 10_000)).resolves.toEqual({
      state: 'NO_WORK',
    });
    expect(await coordinator.reconcileExpired(1, 10_000)).toBe(1);
    expect(
      (await connection.pool.query('select id from probe_execution_attempts')).rows,
    ).toHaveLength(0);
  });

  it('starts a fresh pending deadline when an expired lease is requeued', async () => {
    const fixture = await createFixture('retry-pending-deadline');
    const first = await claimLease(fixture.machine);
    await expire(first.assignmentId, first.attemptId);

    expect(await coordinator.reconcileExpired(1, 10_000)).toBe(1);
    expect(await coordinator.reconcileExpired(1, 10_000)).toBe(0);
    const second = await coordinator.claim(fixture.machine, HTTP_ENGINE_VERSION, 10_000);
    expect(second).toMatchObject({ state: 'CLAIMED', lease: { attemptNumber: 2 } });
    expect(
      (await connection.pool.query('select id from check_execution_results')).rows,
    ).toHaveLength(0);
  });

  it('reconciles pending and running work with independent bounded budgets', async () => {
    const pending = await createFixture('fair-pending');
    await connection.pool.query(
      `update check_execution_assignments
          set pending_since=clock_timestamp()-interval '11 seconds'
        where id=$1`,
      [pending.assignmentId],
    );
    const running = await createFixture('fair-running');
    const lease = await claimLease(running.machine);
    await connection.pool.query(
      `update check_execution_assignments
          set attempt_count=3, claim_expires_at=clock_timestamp()-interval '1 second'
        where id=$1`,
      [running.assignmentId],
    );
    await connection.pool.query(
      `update probe_execution_attempts
          set attempt_number=3,
              leased_at=clock_timestamp()-interval '2 seconds',
              lease_expires_at=clock_timestamp()-interval '1 second'
        where id=$1`,
      [lease.attemptId],
    );

    expect(await coordinator.reconcileExpired(1, 10_000)).toBe(2);
    const results = await connection.pool.query<{ assignment_id: string }>(
      `select assignment_id from check_execution_results
       where assignment_id in ($1, $2)
       order by assignment_id`,
      [pending.assignmentId, running.assignmentId],
    );
    expect(results.rows.map((row) => row.assignment_id).sort()).toEqual(
      [pending.assignmentId, running.assignmentId].sort(),
    );
  });

  it('uses one expiration boundary for concurrent late claims and reconciliation', async () => {
    const fixture = await createFixture('expiration-boundary');
    await connection.pool.query(
      `update check_execution_assignments
          set pending_since=clock_timestamp()-interval '11 seconds'
        where id=$1`,
      [fixture.assignmentId],
    );

    const [claim, reconciled] = await Promise.all([
      coordinator.claim(fixture.machine, HTTP_ENGINE_VERSION, 10_000),
      coordinator.reconcileExpired(1, 10_000),
    ]);
    expect(claim).toEqual({ state: 'NO_WORK' });
    expect(reconciled).toBe(1);
    expect(
      (
        await connection.pool.query('select status from check_execution_assignments where id=$1', [
          fixture.assignmentId,
        ])
      ).rows,
    ).toEqual([{ status: 'COMPLETED' }]);
  });

  it('executes remote locations in parallel and confirms failures with a different healthy agent', async () => {
    const first = await createMachine('multi-first');
    const second = await createMachine('multi-second');
    const confirmation = await createMachine('multi-confirmation', first.locationId, true);
    const monitor = await monitors.create(
      organizationId,
      createMonitor({ name: 'Multi-location execution', url: 'https://example.com/health' }),
    );
    await monitors.updateLocations(organizationId, monitor.id, [
      first.locationId,
      second.locationId,
    ]);
    const round = await new ManualRoundRepository(connection.db, true).create(
      organizationId,
      monitor.id,
    );
    const enabled = new ProbeCoordinatorRepository(connection.db, true);

    const firstClaim = await enabled.claim(first.machine, HTTP_ENGINE_VERSION);
    const secondClaim = await enabled.claim(second.machine, HTTP_ENGINE_VERSION);
    expect(firstClaim.state).toBe('CLAIMED');
    expect(secondClaim.state).toBe('CLAIMED');
    if (firstClaim.state !== 'CLAIMED' || secondClaim.state !== 'CLAIMED') {
      throw new Error('Expected parallel regional claims.');
    }
    const firstFailure = failingResult();
    expect(
      await enabled.submit(
        first.machine,
        resultReference(firstClaim.lease),
        firstClaim.lease.claimToken,
        firstFailure,
      ),
    ).toEqual({ state: 'ACCEPTED', duplicate: false });
    expect(
      await enabled.submit(
        first.machine,
        resultReference(firstClaim.lease),
        firstClaim.lease.claimToken,
        firstFailure,
      ),
    ).toEqual({ state: 'ACCEPTED', duplicate: true });
    expect(
      await enabled.submit(
        first.machine,
        resultReference(firstClaim.lease),
        firstClaim.lease.claimToken,
        { ...firstFailure, attemptDurationMs: 99 },
      ),
    ).toEqual({ state: 'REJECTED', reason: 'REPLAY_MISMATCH' });
    expect(await enabled.claim(first.machine, HTTP_ENGINE_VERSION)).toEqual({ state: 'NO_WORK' });
    const confirmationClaim = await enabled.claim(confirmation.machine, HTTP_ENGINE_VERSION);
    expect(confirmationClaim.state).toBe('CLAIMED');
    if (confirmationClaim.state !== 'CLAIMED') throw new Error('Expected confirmation claim.');
    await enabled.submit(
      confirmation.machine,
      resultReference(confirmationClaim.lease),
      confirmationClaim.lease.claimToken,
      failingResult(),
    );
    await enabled.submit(
      second.machine,
      resultReference(secondClaim.lease),
      secondClaim.lease.claimToken,
      passingResult(),
    );

    expect(
      (
        await connection.pool.query<{ outcome: string }>(
          'select outcome from check_round_aggregates where round_id=$1',
          [round.id],
        )
      ).rows,
    ).toEqual([{ outcome: 'DEGRADED' }]);
    expect(
      (
        await connection.pool.query<{ status: string }>(
          'select status from check_rounds where id=$1',
          [round.id],
        )
      ).rows,
    ).toEqual([{ status: 'COMPLETED' }]);
  });

  it('fences pending and leased regional work when the authoritative deadline wins', async () => {
    const first = await createMachine('deadline-first');
    const second = await createMachine('deadline-second');
    const monitor = await monitors.create(
      organizationId,
      createMonitor({ name: 'Deadline fencing', url: 'https://example.com/health' }),
    );
    await monitors.updateLocations(organizationId, monitor.id, [
      first.locationId,
      second.locationId,
    ]);
    const round = await new ManualRoundRepository(connection.db, true).create(
      organizationId,
      monitor.id,
    );
    const enabled = new ProbeCoordinatorRepository(connection.db, true);
    const claim = await enabled.claim(first.machine, HTTP_ENGINE_VERSION);
    if (claim.state !== 'CLAIMED') throw new Error('Expected a regional claim.');
    await connection.pool.query(
      `update check_rounds
       set created_at=clock_timestamp()-interval '5 minutes',
           finalization_deadline_at=clock_timestamp()-interval '1 second'
       where id=$1`,
      [round.id],
    );

    expect(await new MultiLocationRoundFinalizationRepository(connection.db).finalizeDue(10)).toBe(
      1,
    );
    expect(
      await enabled.renew(first.machine, resultReference(claim.lease), claim.lease.claimToken),
    ).toBeNull();
    expect(
      await enabled.submit(
        first.machine,
        resultReference(claim.lease),
        claim.lease.claimToken,
        passingResult(),
      ),
    ).toEqual({ state: 'REJECTED', reason: 'NON_AUTHORITATIVE_LEASE' });
    expect(
      (
        await connection.pool.query<{ status: string; terminal_reason: string | null }>(
          `select status, terminal_reason from probe_execution_attempts where id=$1`,
          [claim.lease.attemptId],
        )
      ).rows,
    ).toEqual([{ status: 'REJECTED', terminal_reason: 'ROUND_FINALIZED' }]);
    expect(
      (
        await connection.pool.query<{ status: string }>(
          'select status from check_execution_assignments where round_id=$1 order by location',
          [round.id],
        )
      ).rows,
    ).toEqual([{ status: 'COMPLETED' }, { status: 'COMPLETED' }]);
  });

  it('does not reopen an assignment when accepted evidence crosses the round deadline', async () => {
    const first = await createMachine('boundary-first');
    const second = await createMachine('boundary-second');
    const monitor = await monitors.create(
      organizationId,
      createMonitor({ name: 'Deadline boundary', url: 'https://example.com/health' }),
    );
    await monitors.updateLocations(organizationId, monitor.id, [
      first.locationId,
      second.locationId,
    ]);
    const round = await new ManualRoundRepository(connection.db, true).create(
      organizationId,
      monitor.id,
    );
    const enabled = new ProbeCoordinatorRepository(connection.db, true);
    const claim = await enabled.claim(first.machine, HTTP_ENGINE_VERSION);
    if (claim.state !== 'CLAIMED') throw new Error('Expected a regional claim.');
    await connection.pool.query(`
      create function watchrail_test_delay_regional_evidence() returns trigger language plpgsql as $$
      begin
        perform pg_sleep(0.15);
        return new;
      end;
      $$;
      create trigger watchrail_test_delay_regional_evidence
      before insert on check_regional_executions
      for each row execute function watchrail_test_delay_regional_evidence();
    `);
    try {
      await connection.pool.query(
        `update check_rounds
         set finalization_deadline_at=clock_timestamp()+interval '75 milliseconds'
         where id=$1`,
        [round.id],
      );
      expect(
        await enabled.submit(
          first.machine,
          resultReference(claim.lease),
          claim.lease.claimToken,
          failingResult(),
        ),
      ).toEqual({ state: 'ACCEPTED', duplicate: false });
    } finally {
      await connection.pool.query(`
        drop trigger watchrail_test_delay_regional_evidence on check_regional_executions;
        drop function watchrail_test_delay_regional_evidence();
      `);
    }

    expect(
      (
        await connection.pool.query<{ status: string }>(
          'select status from check_rounds where id=$1',
          [round.id],
        )
      ).rows,
    ).toEqual([{ status: 'COMPLETED' }]);
    expect(
      (
        await connection.pool.query<{ status: string }>(
          'select status from check_execution_assignments where id=$1',
          [claim.lease.assignmentId],
        )
      ).rows,
    ).toEqual([{ status: 'COMPLETED' }]);
    expect(
      (
        await connection.pool.query<{ status: string; terminal_reason: string | null }>(
          'select status, terminal_reason from probe_execution_attempts where id=$1',
          [claim.lease.attemptId],
        )
      ).rows,
    ).toEqual([{ status: 'REJECTED', terminal_reason: 'ROUND_FINALIZED' }]);
  });

  it('falls back to the primary agent when no healthy confirmation peer exists', async () => {
    const first = await createMachine('fallback-first');
    const second = await createMachine('fallback-second');
    const monitor = await monitors.create(
      organizationId,
      createMonitor({ name: 'Confirmation fallback', url: 'https://example.com/health' }),
    );
    await monitors.updateLocations(organizationId, monitor.id, [
      first.locationId,
      second.locationId,
    ]);
    await new ManualRoundRepository(connection.db, true).create(organizationId, monitor.id);
    const enabled = new ProbeCoordinatorRepository(connection.db, true);
    const primary = await enabled.claim(first.machine, HTTP_ENGINE_VERSION);
    if (primary.state !== 'CLAIMED') throw new Error('Expected a primary claim.');
    await enabled.submit(
      first.machine,
      resultReference(primary.lease),
      primary.lease.claimToken,
      failingResult(),
    );

    const confirmation = await enabled.claim(first.machine, HTTP_ENGINE_VERSION);
    expect(confirmation).toMatchObject({
      state: 'CLAIMED',
      lease: { assignmentId: primary.lease.assignmentId, attemptNumber: 2 },
    });
  });

  async function createMachine(suffix: string, existingLocationId?: string, online = false) {
    const locationId =
      existingLocationId ??
      (
        await connection.pool.query<{ id: string }>(
          `insert into probe_locations (organization_id,name,slug) values ($1,$2,$3) returning id`,
          [organizationId, `Location ${suffix}`, `location-${suffix}`],
        )
      ).rows[0]!.id;
    const agent = await connection.pool.query<{ id: string }>(
      `insert into probe_agents
        (organization_id,location_id,name,status,last_heartbeat_at,engine_version)
       values ($1,$2,$3,'ACTIVE',$4,$5) returning id`,
      [
        organizationId,
        locationId,
        `Agent ${suffix}`,
        online ? new Date() : null,
        HTTP_ENGINE_VERSION,
      ],
    );
    const credential = await connection.pool.query<{ id: string }>(
      `insert into probe_agent_credentials (organization_id,agent_id,version_number,verifier)
       values ($1,$2,1,$3) returning id`,
      [organizationId, agent.rows[0]!.id, verifierFor(suffix)],
    );
    return {
      locationId,
      machine: {
        agentId: agent.rows[0]!.id,
        organizationId,
        locationId,
        credentialId: credential.rows[0]!.id,
        credentialVersion: 1,
      } satisfies ProbeMachineIdentity,
    };
  }

  async function createFixture(suffix = 'default', scheduled = false) {
    const location = await connection.pool.query<{ id: string }>(
      `insert into probe_locations (organization_id,name,slug) values ($1,$2,$3) returning id`,
      [organizationId, `Location ${suffix}`, `location-${suffix}`],
    );
    const agent = await connection.pool.query<{ id: string }>(
      `insert into probe_agents (organization_id,location_id,name,status)
       values ($1,$2,$3,'ACTIVE') returning id`,
      [organizationId, location.rows[0]!.id, `Agent ${suffix}`],
    );
    const credential = await connection.pool.query<{ id: string }>(
      `insert into probe_agent_credentials (organization_id,agent_id,version_number,verifier)
       values ($1,$2,1,$3) returning id`,
      [organizationId, agent.rows[0]!.id, verifierFor(suffix)],
    );
    const monitor = await monitors.create(
      organizationId,
      createMonitor({ name: `Monitor ${suffix}`, url: 'https://example.com/health' }),
    );
    await monitors.updateLocations(organizationId, monitor.id, [location.rows[0]!.id]);
    const round = await rounds.create(organizationId, monitor.id);
    const assignment = await connection.pool.query<{ id: string }>(
      'select id from check_execution_assignments where round_id=$1',
      [round.id],
    );
    if (scheduled) {
      await connection.pool.query(`update check_rounds set trigger='SCHEDULED' where id=$1`, [
        round.id,
      ]);
    }
    return {
      assignmentId: assignment.rows[0]!.id,
      machine: {
        agentId: agent.rows[0]!.id,
        organizationId,
        locationId: location.rows[0]!.id,
        credentialId: credential.rows[0]!.id,
        credentialVersion: 1,
      } satisfies ProbeMachineIdentity,
    };
  }

  async function claimLease(machine: ProbeMachineIdentity) {
    const claim = await coordinator.claim(machine, HTTP_ENGINE_VERSION);
    if (claim.state !== 'CLAIMED') throw new Error('Expected a probe lease.');
    return claim.lease;
  }

  async function expire(assignmentId: string, attemptId: string): Promise<void> {
    await connection.pool.query(
      `update check_execution_assignments set claim_expires_at=clock_timestamp()-interval '1 second' where id=$1`,
      [assignmentId],
    );
    await connection.pool.query(
      `update probe_execution_attempts
          set leased_at=clock_timestamp()-interval '2 seconds',
              lease_expires_at=clock_timestamp()-interval '1 second'
        where id=$1`,
      [attemptId],
    );
  }

  function createNamedConnection(applicationName: string): DatabaseConnection {
    const uri = new URL(container.getConnectionUri());
    uri.searchParams.set('application_name', applicationName);
    return createDatabaseConnection(uri.toString());
  }

  async function waitForApplicationLock(applicationName: string): Promise<void> {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const result = await connection.pool.query<{ waiting: boolean }>(
        `select exists (
           select 1 from pg_stat_activity
           where application_name=$1 and wait_event_type='Lock'
         ) as waiting`,
        [applicationName],
      );
      if (result.rows[0]?.waiting === true) return;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
    }
    throw new Error(`Timed out waiting for ${applicationName} to block on the location lock.`);
  }
});

function verifierFor(value: string): string {
  return Buffer.from(value.padEnd(32, 'x').slice(0, 32)).toString('base64url');
}

function resultReference(lease: {
  assignmentId: string;
  attemptId: string;
  attemptNumber: number;
}) {
  return {
    contractVersion: 1 as const,
    assignmentId: lease.assignmentId,
    attemptId: lease.attemptId,
    attemptNumber: lease.attemptNumber,
    engineVersion: HTTP_ENGINE_VERSION,
  };
}

function passingResult(): AuthoritativeCheckResult {
  return {
    outcome: 'PASS',
    stage: 'HTTP',
    reason: 'COMPLETED',
    statusCode: 200,
    responseTimeMs: 20,
    attemptDurationMs: 25,
    redirects: [],
    assertionEvaluation: EMPTY_ASSERTION_EVALUATION,
    checkedAt: new Date(),
  };
}

function failingResult(): AuthoritativeCheckResult {
  return {
    ...passingResult(),
    outcome: 'FAIL',
    reason: 'REQUEST_TIMEOUT',
    statusCode: null,
    responseTimeMs: null,
  };
}
