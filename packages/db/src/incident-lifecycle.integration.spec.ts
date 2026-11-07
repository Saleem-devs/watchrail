import { resolve } from 'node:path';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createMonitor, EMPTY_ASSERTION_EVALUATION } from '@watchrail/domain';
import {
  CheckExecutionRepository,
  type AuthoritativeCheckResult,
} from './check-execution-repository.js';
import { createDatabaseConnection, type DatabaseConnection } from './client.js';
import { ManualRoundRepository } from './manual-round-repository.js';
import { IncidentReadRepository } from './incident-read-repository.js';
import {
  IncidentActionNotFoundError,
  IncidentActionRepository,
} from './incident-action-repository.js';
import { migrateDatabase } from './migration.js';
import { MaintenanceWindowRepository } from './maintenance-window-repository.js';
import { MonitorRepository } from './monitor-repository.js';
import { ScheduledRoundRepository } from './scheduled-round-repository.js';
import {
  checkExecutionAssignments,
  checkExecutionResults,
  checkRounds,
  incidents,
  incidentActionEvents,
  monitorIncidentState,
  monitors,
  notificationEvents,
} from './schema.js';

const organizationId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

describe('incident lifecycle', () => {
  let container: StartedPostgreSqlContainer;
  let connection: DatabaseConnection;
  let monitorId: string;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:18.0-alpine').start();
    connection = createDatabaseConnection(container.getConnectionUri());
    await migrateDatabase(connection, resolve(process.cwd(), 'drizzle'));
  }, 60_000);

  beforeEach(async () => {
    await connection.pool.query(`
      truncate table
        maintenance_windows,
        incidents,
        monitor_incident_state,
        check_execution_results,
        check_round_outbox,
        check_execution_assignments,
        check_rounds,
        monitor_configuration_versions,
        monitors
      cascade
    `);
    const monitor = await new MonitorRepository(connection.db).create(
      organizationId,
      createMonitor({ name: 'Incident monitor', url: 'https://example.com' }),
    );
    monitorId = monitor.id;
  });

  afterAll(async () => {
    await connection?.pool.end();
    await container?.stop();
  });

  it('opens one incident on the third scheduled failure and keeps it open', async () => {
    const first = await scheduledRound();
    const second = await scheduledRound();
    const third = await scheduledRound();
    const fourth = await scheduledRound();

    await complete(first.id, unhealthy());
    expect(await state()).toMatchObject({ consecutiveFailures: 1 });
    expect(await connection.db.select().from(incidents)).toEqual([]);

    await complete(second.id, unhealthy());
    expect(await state()).toMatchObject({ consecutiveFailures: 2 });
    expect(await connection.db.select().from(incidents)).toEqual([]);

    await complete(third.id, unhealthy());
    const [opened] = await connection.db.select().from(incidents);
    expect(await state()).toMatchObject({
      consecutiveFailures: 3,
      failureStreakStartedRoundId: first.id,
      lastProcessedRoundId: third.id,
    });
    expect(opened).toMatchObject({
      status: 'OPEN',
      startedByRoundId: first.id,
      openedByRoundId: third.id,
      resolvedAt: null,
    });

    await complete(fourth.id, unhealthy());
    expect(await state()).toMatchObject({ consecutiveFailures: 4 });
    expect(await connection.db.select().from(incidents)).toHaveLength(1);
    await expect(
      new IncidentReadRepository(connection.db).currentForMonitor(organizationId, monitorId),
    ).resolves.toMatchObject({
      failureStreak: { count: 4, threshold: 3, startedByRoundId: first.id },
      currentIncident: { id: opened!.id, status: 'OPEN', openedByRoundId: third.id },
    });
  });

  it('resets before threshold, resolves an open incident, and permits a later incident', async () => {
    await complete((await scheduledRound()).id, unhealthy());
    await complete((await scheduledRound()).id, unhealthy());
    await complete((await scheduledRound()).id, healthy());
    expect(await state()).toMatchObject({
      consecutiveFailures: 0,
      failureStreakStartedAt: null,
      failureStreakStartedRoundId: null,
    });

    await complete((await scheduledRound()).id, unhealthy());
    await complete((await scheduledRound()).id, unhealthy());
    await complete((await scheduledRound()).id, unhealthy());
    const recovery = await scheduledRound();
    await complete(recovery.id, healthy());
    const [resolved] = await connection.db.select().from(incidents);
    expect(resolved).toMatchObject({
      status: 'RESOLVED',
      resolvedByRoundId: recovery.id,
    });

    await complete((await scheduledRound()).id, unhealthy());
    await complete((await scheduledRound()).id, unhealthy());
    await complete((await scheduledRound()).id, unhealthy());
    const allIncidents = await connection.db.select().from(incidents);
    expect(allIncidents).toHaveLength(2);
    expect(allIncidents.filter((incident) => incident.status === 'OPEN')).toHaveLength(1);

    const reads = new IncidentReadRepository(connection.db);
    const firstPage = await reads.listForMonitor(organizationId, monitorId, { limit: 1 });
    expect(firstPage.items).toHaveLength(1);
    expect(firstPage.nextCursor).not.toBeNull();
    const secondPage = await reads.listForMonitor(organizationId, monitorId, {
      limit: 1,
      cursor: firstPage.nextCursor!,
    });
    expect(secondPage.items).toHaveLength(1);
    expect(new Set([...firstPage.items, ...secondPage.items].map((value) => value.id)).size).toBe(
      2,
    );
    const detail = await reads.findForMonitor(organizationId, monitorId, resolved!.id);
    expect(detail).toMatchObject({
      status: 'RESOLVED',
      startedByRoundId: expect.any(String),
      openedByRoundId: expect.any(String),
      resolvedByRoundId: recovery.id,
    });
  });

  it('leaves a failure streak unchanged for indeterminate results and ignores manual checks', async () => {
    const first = await scheduledRound();
    await complete(first.id, unhealthy());
    await complete((await scheduledRound()).id, internalError());
    await complete((await scheduledRound()).id, prohibitedDestination());
    await complete((await scheduledRound()).id, certificateEvidenceUnavailable());
    await complete((await scheduledRound()).id, notEvaluated());
    expect(await state()).toMatchObject({
      consecutiveFailures: 1,
      failureStreakStartedRoundId: first.id,
    });

    const manual = await new ManualRoundRepository(connection.db).create(organizationId, monitorId);
    await complete(manual.id, unhealthy());
    expect(await state()).toMatchObject({
      consecutiveFailures: 1,
      failureStreakStartedRoundId: first.id,
    });
  });

  it('ignores pre-tracking rounds and duplicate worker completion', async () => {
    const preTracking = await scheduledRound();
    await connection.db
      .update(monitorIncidentState)
      .set({ trackingStartedAt: new Date('2030-01-01T00:00:00Z') })
      .where(eq(monitorIncidentState.monitorId, monitorId));
    await complete(preTracking.id, unhealthy());
    expect(await state()).toMatchObject({
      consecutiveFailures: 0,
      lastProcessedRoundId: null,
    });

    await connection.db
      .update(monitorIncidentState)
      .set({ trackingStartedAt: new Date('2020-01-01T00:00:00Z') })
      .where(eq(monitorIncidentState.monitorId, monitorId));
    const round = await scheduledRound();
    const executions = new CheckExecutionRepository(connection.db);
    const claim = await executions.claim(round.id, 45_000);
    if (claim.state !== 'CLAIMED') throw new Error('Expected claim.');
    await expect(
      executions.complete(claim.execution.assignmentId, claim.execution.claimToken, unhealthy()),
    ).resolves.toBe(true);
    await expect(
      executions.complete(claim.execution.assignmentId, claim.execution.claimToken, unhealthy()),
    ).resolves.toBe(false);
    expect(await state()).toMatchObject({ consecutiveFailures: 1 });
  });

  it('persists stale scheduled results without rewinding newer incident state', async () => {
    const older = await scheduledRound();
    const newer = await scheduledRound();
    await connection.db
      .update(checkRounds)
      .set({
        createdAt: new Date('2030-01-01T00:00:00Z'),
        finalizationDeadlineAt: new Date('2030-01-01T00:02:00Z'),
      })
      .where(eq(checkRounds.id, older.id));
    await connection.db
      .update(checkRounds)
      .set({
        createdAt: new Date('2030-01-01T00:01:00Z'),
        finalizationDeadlineAt: new Date('2030-01-01T00:03:00Z'),
      })
      .where(eq(checkRounds.id, newer.id));

    await complete(newer.id, unhealthy());
    await complete(older.id, healthy());

    expect(await state()).toMatchObject({
      consecutiveFailures: 1,
      failureStreakStartedRoundId: newer.id,
      lastProcessedRoundId: newer.id,
    });
    expect(await connection.db.select().from(checkExecutionResults)).toHaveLength(2);
  });

  it('serializes concurrent threshold completions without duplicate open incidents', async () => {
    await complete((await scheduledRound()).id, unhealthy());
    await complete((await scheduledRound()).id, unhealthy());
    const third = await scheduledRound();
    const fourth = await scheduledRound();

    await Promise.all([complete(third.id, unhealthy()), complete(fourth.id, unhealthy())]);

    expect((await state()).consecutiveFailures).toBeGreaterThanOrEqual(3);
    expect(await connection.db.select().from(incidents)).toHaveLength(1);
  });

  it('records operator actions and permits a fresh incident after manual resolution', async () => {
    await complete((await scheduledRound()).id, unhealthy());
    await complete((await scheduledRound()).id, unhealthy());
    await complete((await scheduledRound()).id, unhealthy());
    const [opened] = await connection.db.select().from(incidents);
    if (!opened) throw new Error('Expected open incident.');
    const delayedPreResolutionRound = await scheduledRound();
    const actorId = '11111111-1111-4111-8111-111111111111';
    const actions = new IncidentActionRepository(connection.db);

    const acknowledged = await actions.acknowledge(organizationId, opened.id, actorId);
    expect(acknowledged).toMatchObject({ acknowledgedByActorId: actorId });
    await expect(actions.acknowledge(organizationId, opened.id, actorId)).resolves.toMatchObject({
      acknowledgedByActorId: actorId,
    });
    const until = new Date(Date.now() + 60 * 60 * 1_000);
    const silenced = await actions.silence(organizationId, opened.id, actorId, until);
    expect(silenced).toMatchObject({ silencedByActorId: actorId, silencedUntil: until });
    await expect(actions.silence(organizationId, opened.id, actorId, until)).resolves.toMatchObject(
      {
        silencedUntil: until,
      },
    );
    expect((await actions.unsilence(organizationId, opened.id, actorId)).silencedUntil).toBeNull();
    await expect(actions.unsilence(organizationId, opened.id, actorId)).resolves.toMatchObject({
      silencedUntil: null,
    });
    const resolved = await actions.resolve(
      organizationId,
      opened.id,
      actorId,
      'Known deployment issue',
    );
    expect(resolved).toMatchObject({
      status: 'RESOLVED',
      resolvedByRoundId: null,
      resolvedByActorId: actorId,
      resolutionNote: 'Known deployment issue',
    });
    expect(await state()).toMatchObject({
      consecutiveFailures: 0,
      failureStreakStartedAt: null,
      multiLocationSeverity: null,
    });
    expect(
      (await actions.listEvents(organizationId, opened.id)).map(({ action }) => action),
    ).toEqual(['ACKNOWLEDGED', 'SILENCED', 'UNSILENCED', 'MANUALLY_RESOLVED']);

    await connection.db.execute(sql`
      update incidents
      set resolved_at=date_trunc('milliseconds', resolved_at) + interval '900 microseconds'
      where organization_id=${organizationId}::uuid and id=${opened.id}::uuid
    `);
    await connection.db.execute(sql`
      update monitor_incident_state
      set tracking_started_at=(
        select resolved_at from incidents
        where organization_id=${organizationId}::uuid and id=${opened.id}::uuid
      )
      where organization_id=${organizationId}::uuid and monitor_id=${monitorId}::uuid
    `);
    await connection.db.execute(sql`
      update check_rounds
      set created_at=(
        select date_trunc('milliseconds', resolved_at) + interval '100 microseconds'
        from incidents
        where organization_id=${organizationId}::uuid and id=${opened.id}::uuid
      )
      where organization_id=${organizationId}::uuid and id=${delayedPreResolutionRound.id}::uuid
    `);

    await complete(delayedPreResolutionRound.id, unhealthy());
    expect(await state()).toMatchObject({ consecutiveFailures: 0 });
    expect(
      (await connection.db.select().from(incidents)).filter(({ status }) => status === 'OPEN'),
    ).toHaveLength(0);

    for (const offsetSeconds of [1, 2, 3]) {
      const fresh = await scheduledRound();
      await connection.db.execute(sql`
        update check_rounds
        set created_at=clock_timestamp() + (${offsetSeconds} * interval '1 second')
        where organization_id=${organizationId}::uuid and id=${fresh.id}::uuid
      `);
      await complete(fresh.id, unhealthy());
    }
    expect(
      (await connection.db.select().from(incidents)).filter(({ status }) => status === 'OPEN'),
    ).toHaveLength(1);
  });

  it('suppresses recovery notification staging while an incident is silenced', async () => {
    await complete((await scheduledRound()).id, unhealthy());
    await complete((await scheduledRound()).id, unhealthy());
    await complete((await scheduledRound()).id, unhealthy());
    const [opened] = await connection.db.select().from(incidents);
    if (!opened) throw new Error('Expected open incident.');
    const actions = new IncidentActionRepository(connection.db);
    await actions.silence(
      organizationId,
      opened.id,
      '11111111-1111-4111-8111-111111111111',
      new Date(Date.now() + 60 * 60 * 1_000),
    );

    await complete((await scheduledRound()).id, healthy());

    expect(
      (await connection.db.select().from(notificationEvents)).map(({ eventType }) => eventType),
    ).toEqual(['INCIDENT_OPENED']);
    await expect(
      actions.acknowledge(
        'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        opened.id,
        '11111111-1111-4111-8111-111111111111',
      ),
    ).rejects.toBeInstanceOf(IncidentActionNotFoundError);
    expect(await connection.db.select().from(incidentActionEvents)).toHaveLength(1);
  });

  it('serializes competing silence and resume actions into a coherent audit trail', async () => {
    await complete((await scheduledRound()).id, unhealthy());
    await complete((await scheduledRound()).id, unhealthy());
    await complete((await scheduledRound()).id, unhealthy());
    const [opened] = await connection.db.select().from(incidents);
    if (!opened) throw new Error('Expected open incident.');
    const actions = new IncidentActionRepository(connection.db);
    await Promise.all([
      actions.silence(
        organizationId,
        opened.id,
        '11111111-1111-4111-8111-111111111111',
        new Date(Date.now() + 60 * 60_000),
      ),
      actions.unsilence(organizationId, opened.id, '22222222-2222-4222-8222-222222222222'),
    ]);

    const [stored] = await connection.db.select().from(incidents);
    const eventActions = (await actions.listEvents(organizationId, opened.id)).map(
      ({ action }) => action,
    );
    expect(eventActions).toEqual(stored?.silencedUntil ? ['SILENCED'] : ['SILENCED', 'UNSILENCED']);
  });

  it('serializes competing manual resolutions and records exactly one audit event', async () => {
    await complete((await scheduledRound()).id, unhealthy());
    await complete((await scheduledRound()).id, unhealthy());
    await complete((await scheduledRound()).id, unhealthy());
    const [opened] = await connection.db.select().from(incidents);
    if (!opened) throw new Error('Expected open incident.');
    const actions = new IncidentActionRepository(connection.db);
    const attempts = await Promise.allSettled([
      actions.resolve(
        organizationId,
        opened.id,
        '11111111-1111-4111-8111-111111111111',
        'Primary response',
      ),
      actions.resolve(
        organizationId,
        opened.id,
        '22222222-2222-4222-8222-222222222222',
        'Competing response',
      ),
    ]);

    expect(attempts.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
    expect(attempts.filter(({ status }) => status === 'rejected')).toHaveLength(1);
    expect(await connection.db.select().from(incidentActionEvents)).toHaveLength(1);
  });

  it('serializes manual resolution against authoritative recovery without mixing classifications', async () => {
    await complete((await scheduledRound()).id, unhealthy());
    await complete((await scheduledRound()).id, unhealthy());
    await complete((await scheduledRound()).id, unhealthy());
    const [opened] = await connection.db.select().from(incidents);
    if (!opened) throw new Error('Expected open incident.');
    const recoveryRound = await scheduledRound();
    const attempts = await Promise.allSettled([
      new IncidentActionRepository(connection.db).resolve(
        organizationId,
        opened.id,
        '11111111-1111-4111-8111-111111111111',
        'Operator classification',
      ),
      complete(recoveryRound.id, healthy()),
    ]);

    expect(attempts.some(({ status }) => status === 'fulfilled')).toBe(true);
    const [resolved] = await connection.db.select().from(incidents);
    expect(resolved?.status).toBe('RESOLVED');
    expect(Boolean(resolved?.resolvedByRoundId)).not.toBe(Boolean(resolved?.resolvedByActorId));
    const actionEvents = await connection.db.select().from(incidentActionEvents);
    expect(actionEvents).toHaveLength(resolved?.resolvedByActorId ? 1 : 0);
    expect(
      (await connection.db.select().from(notificationEvents)).filter(
        ({ eventType }) => eventType === 'INCIDENT_RESOLVED',
      ),
    ).toHaveLength(resolved?.resolvedByRoundId ? 1 : 0);
  });

  it('suppresses new incidents and notifications independently during maintenance', async () => {
    const [monitor] = await connection.db
      .select({ projectId: monitors.projectId })
      .from(monitors)
      .where(eq(monitors.id, monitorId));
    const windows = new MaintenanceWindowRepository(connection.db);
    const incidentSuppression = await windows.create(
      organizationId,
      monitor!.projectId,
      '11111111-1111-4111-8111-111111111111',
      maintenanceInput({ suppressIncidentCreation: true, suppressNotifications: false }),
    );
    await complete((await scheduledRound()).id, unhealthy());
    await complete((await scheduledRound()).id, unhealthy());
    await complete((await scheduledRound()).id, unhealthy());
    expect(await connection.db.select().from(incidents)).toEqual([]);
    expect(await state()).toMatchObject({ consecutiveFailures: 0 });

    await windows.archive(
      organizationId,
      monitor!.projectId,
      incidentSuppression.id,
      '11111111-1111-4111-8111-111111111111',
    );
    await complete((await scheduledRound()).id, unhealthy());
    await complete((await scheduledRound()).id, unhealthy());
    await complete((await scheduledRound()).id, unhealthy());
    expect(await connection.db.select().from(incidents)).toHaveLength(1);
    expect(await connection.db.select().from(notificationEvents)).toHaveLength(1);

    await windows.create(
      organizationId,
      monitor!.projectId,
      '11111111-1111-4111-8111-111111111111',
      maintenanceInput({ suppressIncidentCreation: false, suppressNotifications: true }),
    );
    await complete((await scheduledRound()).id, healthy());
    expect((await connection.db.select().from(incidents))[0]).toMatchObject({ status: 'RESOLVED' });
    expect(await connection.db.select().from(notificationEvents)).toHaveLength(1);
  });

  it('rolls back result completion and state when incident insertion fails', async () => {
    await complete((await scheduledRound()).id, unhealthy());
    await complete((await scheduledRound()).id, unhealthy());
    const third = await scheduledRound();
    const executions = new CheckExecutionRepository(connection.db);
    const claim = await executions.claim(third.id, 45_000);
    if (claim.state !== 'CLAIMED') throw new Error('Expected claim.');
    await connection.pool.query(`
      create function watchrail_test_fail_incident() returns trigger language plpgsql as $$
      begin
        raise exception 'forced incident failure';
      end;
      $$;
      create trigger watchrail_test_fail_incident
      before insert on incidents
      for each row execute function watchrail_test_fail_incident();
    `);

    try {
      await expect(
        executions.complete(claim.execution.assignmentId, claim.execution.claimToken, unhealthy()),
      ).rejects.toThrow();
    } finally {
      await connection.pool.query(`
        drop trigger watchrail_test_fail_incident on incidents;
        drop function watchrail_test_fail_incident();
      `);
    }

    expect(await state()).toMatchObject({ consecutiveFailures: 2 });
    expect(await connection.db.select().from(incidents)).toEqual([]);
    expect(
      await connection.db
        .select()
        .from(checkExecutionResults)
        .where(eq(checkExecutionResults.roundId, third.id)),
    ).toEqual([]);
    const [assignment] = await connection.db
      .select()
      .from(checkExecutionAssignments)
      .where(eq(checkExecutionAssignments.roundId, third.id));
    const [round] = await connection.db
      .select()
      .from(checkRounds)
      .where(eq(checkRounds.id, third.id));
    expect(assignment?.status).toBe('RUNNING');
    expect(round?.status).toBe('PENDING');
  });

  async function scheduledRound() {
    await connection.db
      .update(monitors)
      .set({ nextCheckAt: sql`clock_timestamp() - interval '1 second'` })
      .where(eq(monitors.id, monitorId));
    const [round] = await new ScheduledRoundRepository(connection.db).dispatchDue(1);
    if (!round) throw new Error('Expected scheduled round.');
    return round;
  }

  async function complete(roundId: string, result: AuthoritativeCheckResult): Promise<void> {
    const executions = new CheckExecutionRepository(connection.db);
    const claim = await executions.claim(roundId, 45_000);
    if (claim.state !== 'CLAIMED') throw new Error('Expected claim.');
    expect(
      await executions.complete(claim.execution.assignmentId, claim.execution.claimToken, result),
    ).toBe(true);
  }

  async function state() {
    const [value] = await connection.db
      .select()
      .from(monitorIncidentState)
      .where(eq(monitorIncidentState.monitorId, monitorId));
    if (!value) throw new Error('Expected incident state.');
    return value;
  }
});

function maintenanceInput(effects: {
  suppressIncidentCreation: boolean;
  suppressNotifications: boolean;
}) {
  const now = new Date();
  return {
    name: 'Planned maintenance',
    schedule: {
      type: 'ONE_TIME' as const,
      startsAt: new Date(now.getTime() - 60_000).toISOString(),
      endsAt: new Date(now.getTime() + 60 * 60_000).toISOString(),
    },
    target: { type: 'PROJECT' as const },
    effects: {
      ...effects,
      excludeFromUptime: true,
      publishToStatusPage: false,
    },
  };
}

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

function internalError(): AuthoritativeCheckResult {
  return result({ outcome: 'UNKNOWN', stage: 'PROBE', reason: 'INTERNAL_ERROR' });
}

function prohibitedDestination(): AuthoritativeCheckResult {
  return result({ outcome: 'UNKNOWN', stage: 'DNS', reason: 'PROHIBITED_DESTINATION' });
}

function certificateEvidenceUnavailable(): AuthoritativeCheckResult {
  return result({
    outcome: 'UNKNOWN',
    stage: 'TLS',
    reason: 'CERTIFICATE_EVIDENCE_UNAVAILABLE',
    statusCode: 200,
    responseTimeMs: 5,
  });
}

function notEvaluated(): AuthoritativeCheckResult {
  return result({
    outcome: 'PASS',
    stage: 'HTTP',
    reason: 'COMPLETED',
    statusCode: 200,
    responseTimeMs: 5,
    assertionEvaluation: {
      contractVersion: 1,
      outcome: 'NOT_EVALUATED',
      diagnostics: [
        {
          index: 0,
          source: 'TEXT_BODY',
          subject: null,
          operator: 'contains',
          outcome: 'NOT_EVALUATED',
          reason: 'BODY_READ_FAILED',
        },
      ],
    },
  });
}
