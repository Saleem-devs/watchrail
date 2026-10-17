import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { createMonitor, type ProbeObservationV1 } from '@watchrail/domain';
import { createDatabaseConnection, type DatabaseConnection } from './client.js';
import { migrateDatabase } from './migration.js';
import { IncidentReadRepository } from './incident-read-repository.js';
import { MonitorRepository } from './monitor-repository.js';
import { MultiLocationRoundFinalizationRepository } from './multi-location-finalization-repository.js';
import { ProbeCoordinatorRepository } from './probe-coordinator-repository.js';
import { createPreparedRoutedAssignments, createRoundLocationSnapshot } from './round-routing.js';
import {
  checkExecutionAssignments,
  checkRegionalExecutions,
  checkRoundAggregates,
  checkRounds,
  incidents,
  monitorIncidentState,
  monitorConfigurationVersions,
  notificationEvents,
  probeLocations,
} from './schema.js';

const organizationId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

describe('authoritative multi-location finalization', () => {
  let container: StartedPostgreSqlContainer;
  let connection: DatabaseConnection;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:18.0-alpine').start();
    connection = createDatabaseConnection(container.getConnectionUri());
    await migrateDatabase(connection, resolve(process.cwd(), 'drizzle'));
  }, 60_000);

  beforeEach(async () => {
    await connection.pool.query(`
      truncate table
        notification_deliveries, notification_events, incidents,
        check_round_aggregates, check_regional_evaluations, check_regional_executions,
        check_round_outbox, check_execution_assignments, check_round_locations, check_rounds,
        monitor_configuration_versions, monitors, probe_locations
      cascade
    `);
  });

  afterAll(async () => {
    await connection?.pool.end();
    await container?.stop();
  });

  it('persists regional evidence and waits for every region despite a decided quorum', async () => {
    const fixture = await createFixture(3, 'SCHEDULED');
    const repository = new MultiLocationRoundFinalizationRepository(connection.db);
    await repository.initializeRound(organizationId, fixture.roundId);

    await accept(repository, fixture, 0, 'PASS');
    await accept(repository, fixture, 1, 'PASS');
    expect(await repository.tryFinalizeRound(organizationId, fixture.roundId)).toEqual({
      state: 'WAIT',
      pendingLocationIds: [fixture.locations[2]],
    });
    expect(await connection.db.select().from(checkRoundAggregates)).toEqual([]);
    expect(await connection.db.select().from(incidents)).toEqual([]);

    await accept(repository, fixture, 2, 'PASS');
    const aggregates = await connection.db.select().from(checkRoundAggregates);
    expect(aggregates).toHaveLength(1);
    expect(aggregates[0]).toMatchObject({ outcome: 'UP' });
    expect((await roundStatus(fixture.roundId)).status).toBe('COMPLETED');
  });

  it('finalizes missing regions as UNKNOWN at the database deadline exactly once', async () => {
    const fixture = await createFixture(3, 'MANUAL');
    const repository = new MultiLocationRoundFinalizationRepository(connection.db);
    await repository.initializeRound(organizationId, fixture.roundId);
    await connection.db
      .update(checkRounds)
      .set({
        createdAt: sql`clock_timestamp() - interval '5 minutes'`,
        finalizationDeadlineAt: sql`clock_timestamp() - interval '1 second'`,
      })
      .where(eq(checkRounds.id, fixture.roundId));

    const results = await Promise.all([
      repository.tryFinalizeRound(organizationId, fixture.roundId),
      repository.tryFinalizeRound(organizationId, fixture.roundId),
    ]);
    expect(results.map((result) => result.state).sort()).toEqual(['ALREADY_FINALIZED', 'FINALIZE']);
    const [aggregate] = await connection.db.select().from(checkRoundAggregates);
    expect(aggregate!.aggregate.counts).toMatchObject({ pass: 0, unknown: 3 });
    expect(await connection.db.select().from(checkRoundAggregates)).toHaveLength(1);
  });

  it('accepts semantically identical regional replays before and after round completion', async () => {
    const fixture = await createFixture(2, 'MANUAL');
    const repository = new MultiLocationRoundFinalizationRepository(connection.db);
    const location = fixture.locations[0]!;
    const executionId = randomUUID();
    const input = {
      organizationId,
      roundId: fixture.roundId,
      assignmentId: fixture.assignments.get(location)!,
      location,
      executionId,
      agentId: 'replay-agent',
      role: 'PRIMARY' as const,
    };
    const original: ProbeObservationV1 = {
      outcome: 'PASS',
      reason: 'COMPLETED',
      assertionOutcome: 'PASS',
    };
    const reordered: ProbeObservationV1 = {
      assertionOutcome: 'PASS',
      reason: 'COMPLETED',
      outcome: 'PASS',
    };

    expect(await repository.recordExecution({ ...input, observation: original })).toMatchObject({
      state: 'ACCEPTED',
    });
    expect(await repository.recordExecution({ ...input, observation: reordered })).toMatchObject({
      state: 'DUPLICATE',
    });
    await accept(repository, fixture, 1, 'PASS');
    expect((await roundStatus(fixture.roundId)).status).toBe('COMPLETED');
    expect(await repository.recordExecution({ ...input, observation: reordered })).toMatchObject({
      state: 'DUPLICATE',
    });
  });

  it('keeps legacy reconciliation away from deadline-finalized multi-location assignments', async () => {
    const fixture = await createFixture(2, 'MANUAL');
    const repository = new MultiLocationRoundFinalizationRepository(connection.db);
    await connection.db
      .update(checkRounds)
      .set({ finalizationDeadlineAt: sql`clock_timestamp() - interval '1 second'` })
      .where(eq(checkRounds.id, fixture.roundId));
    await connection.db
      .update(checkExecutionAssignments)
      .set({ pendingSince: sql`clock_timestamp() - interval '10 minutes'` })
      .where(eq(checkExecutionAssignments.roundId, fixture.roundId));

    expect(await repository.tryFinalizeRound(organizationId, fixture.roundId)).toMatchObject({
      state: 'FINALIZE',
    });
    expect(await new ProbeCoordinatorRepository(connection.db).reconcileExpired(100, 60_000)).toBe(
      0,
    );
    expect(
      await connection.db
        .select({ status: checkExecutionAssignments.status })
        .from(checkExecutionAssignments)
        .where(eq(checkExecutionAssignments.roundId, fixture.roundId)),
    ).toEqual([{ status: 'COMPLETED' }, { status: 'COMPLETED' }]);
  });

  it('rolls back evidence, aggregate, incident, notification and round completion together', async () => {
    const fixture = await createFixture(3, 'SCHEDULED');
    const repository = new MultiLocationRoundFinalizationRepository(connection.db);
    await repository.initializeRound(organizationId, fixture.roundId);
    await accept(repository, fixture, 0, 'PASS');
    await failAndConfirm(repository, fixture, 1);
    await connection.pool.query(`
      create function reject_multi_notification() returns trigger language plpgsql as $$
      begin raise exception 'synthetic notification failure'; end $$
    `);
    await connection.pool.query(`
      create trigger reject_multi_notification before insert on notification_events
      for each row execute function reject_multi_notification()
    `);
    await expect(accept(repository, fixture, 2, 'UNKNOWN')).rejects.toThrow();
    expect(await connection.db.select().from(checkRoundAggregates)).toEqual([]);
    expect(await connection.db.select().from(incidents)).toEqual([]);
    expect(await connection.db.select().from(notificationEvents)).toEqual([]);
    expect((await roundStatus(fixture.roundId)).status).toBe('PENDING');
    expect(
      await connection.db
        .select()
        .from(checkRegionalExecutions)
        .where(eq(checkRegionalExecutions.location, fixture.locations[2]!)),
    ).toEqual([]);
    await connection.pool.query('drop trigger reject_multi_notification on notification_events');
    await connection.pool.query('drop function reject_multi_notification()');
  });

  it('requires two distinct healthy scheduled rounds to resolve a multi-location incident', async () => {
    const repository = new MultiLocationRoundFinalizationRepository(connection.db);
    const failed = await createFixture(2, 'SCHEDULED');
    await repository.initializeRound(organizationId, failed.roundId);
    await failAndConfirm(repository, failed, 0);
    await failAndConfirm(repository, failed, 1);
    expect((await connection.db.select().from(incidents))[0]).toMatchObject({
      status: 'OPEN',
      severity: 'DOWN',
    });
    const incidentReads = new IncidentReadRepository(connection.db);
    await expect(
      incidentReads.currentForMonitor(organizationId, failed.monitorId),
    ).resolves.toMatchObject({
      failureStreak: null,
      multiLocationIncident: {
        severity: 'DOWN',
        healthyRecoveryStreak: 0,
        healthyRecoveryThreshold: 2,
      },
    });

    const firstHealthy = await createNextRound(failed);
    await repository.initializeRound(organizationId, firstHealthy.roundId);
    await accept(repository, firstHealthy, 0, 'PASS');
    await accept(repository, firstHealthy, 1, 'PASS');
    expect((await connection.db.select().from(incidents))[0]).toMatchObject({ status: 'OPEN' });
    await expect(
      incidentReads.currentForMonitor(organizationId, failed.monitorId),
    ).resolves.toMatchObject({
      multiLocationIncident: { severity: 'DOWN', healthyRecoveryStreak: 1 },
    });
    expect(await repository.tryFinalizeRound(organizationId, firstHealthy.roundId)).toEqual({
      state: 'ALREADY_FINALIZED',
    });
    expect((await connection.db.select().from(incidents))[0]).toMatchObject({ status: 'OPEN' });

    const secondHealthy = await createNextRound(firstHealthy);
    await repository.initializeRound(organizationId, secondHealthy.roundId);
    await accept(repository, secondHealthy, 0, 'PASS');
    await accept(repository, secondHealthy, 1, 'PASS');
    expect((await connection.db.select().from(incidents))[0]).toMatchObject({
      status: 'RESOLVED',
    });
    expect(await connection.db.select().from(notificationEvents)).toHaveLength(2);
  });

  it('adopts an existing single-location incident when multi-location evaluation begins', async () => {
    const fixture = await createFixture(2, 'SCHEDULED');
    const repository = new MultiLocationRoundFinalizationRepository(connection.db);
    const incidentId = randomUUID();
    await connection.db.insert(incidents).values({
      id: incidentId,
      organizationId,
      monitorId: fixture.monitorId,
      status: 'OPEN',
      severity: null,
      startedAt: fixture.createdAt,
      openedAt: fixture.createdAt,
      startedByRoundId: fixture.roundId,
      openedByRoundId: fixture.roundId,
    });
    await connection.db
      .update(monitorIncidentState)
      .set({
        consecutiveFailures: 3,
        failureStreakStartedAt: fixture.createdAt,
        failureStreakStartedRoundId: fixture.roundId,
      })
      .where(eq(monitorIncidentState.monitorId, fixture.monitorId));

    await accept(repository, fixture, 0, 'PASS');
    await failAndConfirm(repository, fixture, 1);

    const open = await connection.db.select().from(incidents);
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ id: incidentId, status: 'OPEN', severity: 'DEGRADED' });
    expect(await connection.db.select().from(notificationEvents)).toEqual([]);
  });

  async function createFixture(locationCount: number, trigger: 'MANUAL' | 'SCHEDULED') {
    const monitors = new MonitorRepository(connection.db);
    const monitor = await monitors.create(
      organizationId,
      createMonitor({ name: `Aggregate ${randomUUID()}`, url: 'https://example.com/health' }),
    );
    const locations = await connection.db
      .insert(probeLocations)
      .values(
        Array.from({ length: locationCount }, (_, index) => ({
          organizationId,
          name: `Region ${index}`,
          slug: `region-${randomUUID()}`,
        })),
      )
      .returning({ id: probeLocations.id });
    const ids = locations.map(({ id }) => id).sort();
    await monitors.updateLocations(organizationId, monitor.id, ids);
    const [configuration] = await connection.db
      .select()
      .from(monitorConfigurationVersions)
      .where(eq(monitorConfigurationVersions.monitorId, monitor.id))
      .orderBy(sql`${monitorConfigurationVersions.versionNumber} desc`)
      .limit(1);
    const createdAt = new Date(Date.now() - 10_000);
    const roundId = await connection.db.transaction(async (tx) => {
      const [round] = await tx
        .insert(checkRounds)
        .values({
          organizationId,
          monitorId: monitor.id,
          monitorConfigurationVersionId: configuration!.id,
          trigger,
          createdAt,
          finalizationDeadlineAt: new Date(createdAt.getTime() + 120_000),
        })
        .returning({ id: checkRounds.id });
      await createRoundLocationSnapshot(tx, { organizationId, roundId: round!.id, locations: ids });
      await createPreparedRoutedAssignments(tx, {
        organizationId,
        roundId: round!.id,
        locations: ids,
      });
      return round!.id;
    });
    const assignments = await connection.db
      .select({ id: checkExecutionAssignments.id, location: checkExecutionAssignments.location })
      .from(checkExecutionAssignments)
      .where(eq(checkExecutionAssignments.roundId, roundId));
    return {
      roundId,
      monitorId: monitor.id,
      configurationVersionId: configuration!.id,
      createdAt,
      locations: ids,
      assignments: new Map(assignments.map((item) => [item.location, item.id])),
    };
  }

  async function createNextRound(previous: Awaited<ReturnType<typeof createFixture>>) {
    const createdAt = new Date(previous.createdAt.getTime() + 1_000);
    const roundId = await connection.db.transaction(async (tx) => {
      const [round] = await tx
        .insert(checkRounds)
        .values({
          organizationId,
          monitorId: previous.monitorId,
          monitorConfigurationVersionId: previous.configurationVersionId,
          trigger: 'SCHEDULED',
          createdAt,
          finalizationDeadlineAt: new Date(createdAt.getTime() + 120_000),
        })
        .returning({ id: checkRounds.id });
      await createRoundLocationSnapshot(tx, {
        organizationId,
        roundId: round!.id,
        locations: previous.locations,
      });
      await createPreparedRoutedAssignments(tx, {
        organizationId,
        roundId: round!.id,
        locations: previous.locations,
      });
      return round!.id;
    });
    const assignments = await connection.db
      .select({ id: checkExecutionAssignments.id, location: checkExecutionAssignments.location })
      .from(checkExecutionAssignments)
      .where(eq(checkExecutionAssignments.roundId, roundId));
    return {
      ...previous,
      roundId,
      createdAt,
      assignments: new Map(assignments.map((item) => [item.location, item.id])),
    };
  }

  async function accept(
    repository: MultiLocationRoundFinalizationRepository,
    fixture: Awaited<ReturnType<typeof createFixture>>,
    index: number,
    outcome: 'PASS' | 'UNKNOWN',
  ) {
    const location = fixture.locations[index]!;
    return repository.recordExecution({
      organizationId,
      roundId: fixture.roundId,
      assignmentId: fixture.assignments.get(location)!,
      location,
      executionId: randomUUID(),
      agentId: `agent-${index}`,
      role: 'PRIMARY',
      observation: {
        outcome,
        reason: outcome === 'PASS' ? 'COMPLETED' : 'INTERNAL_ERROR',
        assertionOutcome: outcome === 'PASS' ? 'PASS' : 'NOT_EVALUATED',
      },
    });
  }

  async function failAndConfirm(
    repository: MultiLocationRoundFinalizationRepository,
    fixture: Awaited<ReturnType<typeof createFixture>>,
    index: number,
  ) {
    const location = fixture.locations[index]!;
    const common = {
      organizationId,
      roundId: fixture.roundId,
      assignmentId: fixture.assignments.get(location)!,
      location,
      agentId: `agent-${index}`,
      observation: {
        outcome: 'FAIL' as const,
        reason: 'REQUEST_TIMEOUT',
        assertionOutcome: 'NOT_EVALUATED' as const,
      },
    };
    await repository.recordExecution({ ...common, executionId: randomUUID(), role: 'PRIMARY' });
    await repository.recordExecution({
      ...common,
      executionId: randomUUID(),
      role: 'CONFIRMATION',
    });
  }

  async function roundStatus(roundId: string) {
    const [round] = await connection.db
      .select({ status: checkRounds.status })
      .from(checkRounds)
      .where(eq(checkRounds.id, roundId));
    return round!;
  }
});
