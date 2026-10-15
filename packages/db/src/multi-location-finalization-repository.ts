import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import {
  createMultiLocationRoundSnapshot,
  deriveMultiLocationIncidentDirective,
  evaluateRoundFinalization,
  initialRegionalEvaluation,
  reduceRegionalEvidence,
  type AggregateRoundDecisionV1,
  type ProbeObservationV1,
  type RegionalEvaluationV1,
  type RoundFinalizationDecisionV1,
} from '@watchrail/domain';
import type { WatchrailDatabase } from './client.js';
import { applyAggregateAvailabilityObservation } from './availability-repository.js';
import {
  stageIncidentNotification,
  type IncidentTransition,
} from './notification-event-repository.js';
import {
  checkRegionalEvaluations,
  checkRegionalExecutions,
  checkRoundAggregates,
  checkRoundLocations,
  checkRounds,
  incidents,
  monitorIncidentState,
} from './schema.js';

type Transaction = Parameters<Parameters<WatchrailDatabase['transaction']>[0]>[0];

export type RegionalExecutionAcceptance =
  | { state: 'ACCEPTED'; evaluation: RegionalEvaluationV1 }
  | { state: 'DUPLICATE'; evaluation: RegionalEvaluationV1 }
  | { state: 'REJECTED'; reason: string };

export class MultiLocationRoundFinalizationRepository {
  constructor(private readonly db: WatchrailDatabase) {}

  async initializeRound(organizationId: string, roundId: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      const round = await lockRound(tx, organizationId, roundId);
      if (round.status === 'COMPLETED') return;
      const locations = await loadLocations(tx, organizationId, roundId);
      if (locations.length < 2)
        throw new Error('Multi-location finalization requires two locations.');
      await ensureEvaluations(tx, organizationId, roundId, locations);
    });
  }

  async recordExecution(input: {
    organizationId: string;
    roundId: string;
    assignmentId: string;
    location: string;
    executionId: string;
    agentId: string;
    role: 'PRIMARY' | 'CONFIRMATION';
    observation: ProbeObservationV1;
  }): Promise<RegionalExecutionAcceptance> {
    return this.db.transaction(async (tx) => {
      const round = await lockRound(tx, input.organizationId, input.roundId);
      const [existing] = await tx
        .select()
        .from(checkRegionalExecutions)
        .where(eq(checkRegionalExecutions.id, input.executionId))
        .limit(1);
      if (existing) {
        const evaluation = await loadEvaluation(
          tx,
          input.organizationId,
          input.roundId,
          input.location,
        );
        return existing.organizationId === input.organizationId &&
          existing.roundId === input.roundId &&
          existing.assignmentId === input.assignmentId &&
          existing.location === input.location &&
          existing.agentId === input.agentId &&
          existing.role === input.role &&
          observationsEqual(existing.observation, input.observation)
          ? { state: 'DUPLICATE', evaluation }
          : { state: 'REJECTED', reason: 'CONFLICTING_REPLAY' };
      }
      if (round.status === 'COMPLETED') return { state: 'REJECTED', reason: 'ROUND_COMPLETED' };

      await ensureEvaluations(tx, input.organizationId, input.roundId, [input.location]);
      const evaluation = await loadEvaluation(
        tx,
        input.organizationId,
        input.roundId,
        input.location,
      );
      const expectedRole = evaluation.phase === 'AWAITING_PRIMARY' ? 'PRIMARY' : 'CONFIRMATION';
      if (evaluation.phase === 'TERMINAL' || input.role !== expectedRole) {
        return { state: 'REJECTED', reason: 'REGION_TERMINAL' };
      }
      const acceptedAt = await databaseNow(tx);
      const decision = reduceRegionalEvidence({
        state: evaluation,
        execution: {
          executionId: input.executionId,
          agentId: input.agentId,
          acceptedAt: acceptedAt.toISOString(),
          observation: input.observation,
        },
        createdAt: round.createdAt.toISOString(),
        deadlineAt: round.finalizationDeadlineAt.toISOString(),
        roundCompleted: false,
      });
      if (decision.disposition === 'REJECTED') {
        return { state: 'REJECTED', reason: decision.reason };
      }
      await tx.insert(checkRegionalExecutions).values({
        id: input.executionId,
        organizationId: input.organizationId,
        roundId: input.roundId,
        assignmentId: input.assignmentId,
        location: input.location,
        agentId: input.agentId,
        role: input.role,
        observation: input.observation,
        acceptedAt,
      });
      await persistEvaluation(tx, input.organizationId, input.roundId, decision.state, acceptedAt);
      await tryFinalizeLocked(tx, round);
      return { state: 'ACCEPTED', evaluation: decision.state };
    });
  }

  async tryFinalizeRound(
    organizationId: string,
    roundId: string,
  ): Promise<RoundFinalizationDecisionV1> {
    return this.db.transaction(async (tx) => {
      const round = await lockRound(tx, organizationId, roundId);
      return tryFinalizeLocked(tx, round);
    });
  }

  async finalizeDue(batchSize: number): Promise<number> {
    if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 1000) {
      throw new RangeError('Finalization batch size must be an integer from 1 to 1000.');
    }
    const due = await this.db
      .select({ organizationId: checkRounds.organizationId, roundId: checkRounds.id })
      .from(checkRounds)
      .innerJoin(
        checkRoundLocations,
        and(
          eq(checkRoundLocations.organizationId, checkRounds.organizationId),
          eq(checkRoundLocations.roundId, checkRounds.id),
        ),
      )
      .where(
        and(
          eq(checkRounds.status, 'PENDING'),
          sql`${checkRounds.finalizationDeadlineAt} <= clock_timestamp()`,
        ),
      )
      .groupBy(checkRounds.organizationId, checkRounds.id, checkRounds.finalizationDeadlineAt)
      .having(sql`count(*) > 1`)
      .orderBy(asc(checkRounds.finalizationDeadlineAt), asc(checkRounds.id))
      .limit(batchSize);
    let finalized = 0;
    for (const round of due) {
      const decision = await this.tryFinalizeRound(round.organizationId, round.roundId);
      if (decision.state === 'FINALIZE') finalized += 1;
    }
    return finalized;
  }
}

async function tryFinalizeLocked(
  tx: Transaction,
  round: Awaited<ReturnType<typeof lockRound>>,
): Promise<RoundFinalizationDecisionV1> {
  if (round.status === 'COMPLETED') return { state: 'ALREADY_FINALIZED' };
  const locations = await loadLocations(tx, round.organizationId, round.id);
  if (locations.length < 2)
    throw new Error('Legacy single-location round requires legacy finalization.');
  await ensureEvaluations(tx, round.organizationId, round.id, locations);
  const states = await loadEvaluations(tx, round.organizationId, round.id, locations);
  const now = await databaseNow(tx);
  const snapshot = createMultiLocationRoundSnapshot({
    contractVersion: 1,
    roundId: round.id,
    organizationId: round.organizationId,
    monitorId: round.monitorId,
    configurationVersionId: round.monitorConfigurationVersionId,
    trigger: round.trigger,
    locations,
    aggregationPolicyVersion: 1,
    confirmationPolicyVersion: 1,
    createdAt: round.createdAt.toISOString(),
    deadlineAt: round.finalizationDeadlineAt.toISOString(),
  });
  const decision = evaluateRoundFinalization({
    snapshot,
    regionalStates: states,
    now: now.toISOString(),
    roundStatus: round.status,
  });
  if (decision.state !== 'FINALIZE') return decision;

  for (const region of decision.aggregate.regions) {
    await persistEvaluation(tx, round.organizationId, round.id, region, now);
  }
  await tx.insert(checkRoundAggregates).values({
    organizationId: round.organizationId,
    roundId: round.id,
    outcome: decision.aggregate.outcome,
    aggregate: decision.aggregate,
    finalizedAt: now,
  });
  if (round.trigger === 'SCHEDULED') {
    const transition = await applyMultiLocationIncident(tx, round, decision.aggregate, now);
    await applyAggregateAvailabilityObservation(tx, round, decision.aggregate.outcome);
    await stageIncidentNotification(tx, transition);
  }
  await tx.update(checkRounds).set({ status: 'COMPLETED' }).where(eq(checkRounds.id, round.id));
  return decision;
}

async function applyMultiLocationIncident(
  tx: Transaction,
  round: Awaited<ReturnType<typeof lockRound>>,
  aggregate: AggregateRoundDecisionV1,
  finalizedAt: Date,
): Promise<IncidentTransition> {
  const [state] = await tx
    .select()
    .from(monitorIncidentState)
    .where(
      and(
        eq(monitorIncidentState.organizationId, round.organizationId),
        eq(monitorIncidentState.monitorId, round.monitorId),
      ),
    )
    .limit(1)
    .for('update');
  if (!state) throw new Error('Monitor incident state is missing.');
  if (
    state.lastProcessedRoundCreatedAt &&
    state.lastProcessedRoundId &&
    (round.createdAt < state.lastProcessedRoundCreatedAt ||
      (round.createdAt.getTime() === state.lastProcessedRoundCreatedAt.getTime() &&
        round.id <= state.lastProcessedRoundId))
  ) {
    return { type: 'NONE' };
  }
  const [active] = await tx
    .select()
    .from(incidents)
    .where(
      and(
        eq(incidents.organizationId, round.organizationId),
        eq(incidents.monitorId, round.monitorId),
        eq(incidents.status, 'OPEN'),
      ),
    )
    .limit(1)
    .for('update');
  const storedSeverity: 'DEGRADED' | 'DOWN' | null =
    state.multiLocationSeverity === 'DEGRADED' || state.multiLocationSeverity === 'DOWN'
      ? state.multiLocationSeverity
      : null;
  const adoptedSeverity: 'DEGRADED' | 'DOWN' | null =
    storedSeverity ??
    (active
      ? aggregate.outcome === 'DEGRADED' || aggregate.outcome === 'DOWN'
        ? aggregate.outcome
        : active.severity === 'DEGRADED'
          ? 'DEGRADED'
          : 'DOWN'
      : null);
  if (active && storedSeverity === null && adoptedSeverity !== null) {
    await tx
      .update(incidents)
      .set({ severity: adoptedSeverity })
      .where(eq(incidents.id, active.id));
  }
  const directive = deriveMultiLocationIncidentDirective({
    selectedLocations: aggregate.counts.selected,
    outcome: aggregate.outcome,
    activeSeverity: adoptedSeverity,
    healthyRecoveryStreak: state.multiLocationHealthyRecoveryStreak as 0 | 1,
  });
  const common = {
    consecutiveFailures: 0,
    failureStreakStartedAt: null,
    failureStreakStartedRoundId: null,
    lastProcessedRoundCreatedAt: round.createdAt,
    lastProcessedRoundId: round.id,
    updatedAt: finalizedAt,
  };
  if (directive.type === 'OPEN') {
    const [opened] = await tx
      .insert(incidents)
      .values({
        organizationId: round.organizationId,
        monitorId: round.monitorId,
        status: 'OPEN',
        severity: directive.severity,
        startedAt: finalizedAt,
        openedAt: finalizedAt,
        startedByRoundId: round.id,
        openedByRoundId: round.id,
      })
      .returning({
        id: incidents.id,
        status: incidents.status,
        startedAt: incidents.startedAt,
        openedAt: incidents.openedAt,
        resolvedAt: incidents.resolvedAt,
      });
    if (!opened) throw new Error('Incident creation returned no record.');
    await tx
      .update(monitorIncidentState)
      .set({
        ...common,
        multiLocationSeverity: directive.severity,
        multiLocationHealthyRecoveryStreak: 0,
      })
      .where(eq(monitorIncidentState.monitorId, round.monitorId));
    return {
      type: 'OPENED',
      incident: opened,
      organizationId: round.organizationId,
      monitorId: round.monitorId,
      triggeringRoundId: round.id,
    };
  }
  if (directive.type === 'ESCALATE' || directive.type === 'DEESCALATE') {
    if (!active) throw new Error('Multi-location incident state is missing its open incident.');
    await tx
      .update(incidents)
      .set({ severity: directive.severity })
      .where(eq(incidents.id, active.id));
    await tx
      .update(monitorIncidentState)
      .set({
        ...common,
        multiLocationSeverity: directive.severity,
        multiLocationHealthyRecoveryStreak: 0,
      })
      .where(eq(monitorIncidentState.monitorId, round.monitorId));
    return { type: 'NONE' };
  }
  if (directive.type === 'RESOLVE') {
    if (!active) throw new Error('Multi-location incident state is missing its open incident.');
    const [resolved] = await tx
      .update(incidents)
      .set({ status: 'RESOLVED', resolvedAt: finalizedAt, resolvedByRoundId: round.id })
      .where(eq(incidents.id, active.id))
      .returning({
        id: incidents.id,
        status: incidents.status,
        startedAt: incidents.startedAt,
        openedAt: incidents.openedAt,
        resolvedAt: incidents.resolvedAt,
      });
    if (!resolved) throw new Error('Incident resolution returned no record.');
    await tx
      .update(monitorIncidentState)
      .set({ ...common, multiLocationSeverity: null, multiLocationHealthyRecoveryStreak: 0 })
      .where(eq(monitorIncidentState.monitorId, round.monitorId));
    return {
      type: 'RESOLVED',
      incident: resolved,
      organizationId: round.organizationId,
      monitorId: round.monitorId,
      triggeringRoundId: round.id,
    };
  }
  const recovery = directive.type === 'RECOVERING' ? 1 : 0;
  await tx
    .update(monitorIncidentState)
    .set({
      ...common,
      multiLocationSeverity: adoptedSeverity,
      multiLocationHealthyRecoveryStreak: recovery,
    })
    .where(eq(monitorIncidentState.monitorId, round.monitorId));
  return { type: 'NONE' };
}

async function ensureEvaluations(
  tx: Transaction,
  organizationId: string,
  roundId: string,
  locations: readonly string[],
) {
  if (locations.length === 0) return;
  await tx
    .insert(checkRegionalEvaluations)
    .values(locations.map((location) => ({ organizationId, roundId, location })))
    .onConflictDoNothing();
}

function observationsEqual(left: ProbeObservationV1, right: ProbeObservationV1): boolean {
  return (
    left.outcome === right.outcome &&
    left.reason === right.reason &&
    left.assertionOutcome === right.assertionOutcome
  );
}

async function lockRound(tx: Transaction, organizationId: string, roundId: string) {
  const [round] = await tx
    .select()
    .from(checkRounds)
    .where(and(eq(checkRounds.organizationId, organizationId), eq(checkRounds.id, roundId)))
    .limit(1)
    .for('update');
  if (!round) throw new Error('Check round is missing.');
  return round;
}

async function loadLocations(tx: Transaction, organizationId: string, roundId: string) {
  return (
    await tx
      .select({ location: checkRoundLocations.location })
      .from(checkRoundLocations)
      .where(
        and(
          eq(checkRoundLocations.organizationId, organizationId),
          eq(checkRoundLocations.roundId, roundId),
        ),
      )
      .orderBy(asc(checkRoundLocations.position))
  ).map((row) => row.location);
}

async function loadEvaluations(
  tx: Transaction,
  organizationId: string,
  roundId: string,
  locations: readonly string[],
) {
  const rows = await tx
    .select()
    .from(checkRegionalEvaluations)
    .where(
      and(
        eq(checkRegionalEvaluations.organizationId, organizationId),
        eq(checkRegionalEvaluations.roundId, roundId),
        inArray(checkRegionalEvaluations.location, locations),
      ),
    )
    .orderBy(asc(checkRegionalEvaluations.location));
  if (rows.length !== locations.length) throw new Error('Regional evaluations are incomplete.');
  const executionIds = rows
    .flatMap((row) => [row.primaryExecutionId, row.confirmationExecutionId])
    .filter((id): id is string => id !== null);
  const executions =
    executionIds.length === 0
      ? []
      : await tx
          .select()
          .from(checkRegionalExecutions)
          .where(inArray(checkRegionalExecutions.id, executionIds));
  const byId = new Map(executions.map((item) => [item.id, item]));
  return rows.map((row) => evaluationFromRow(row, byId));
}

async function loadEvaluation(
  tx: Transaction,
  organizationId: string,
  roundId: string,
  location: string,
) {
  const all = await loadEvaluations(tx, organizationId, roundId, [location]);
  return all[0]!;
}

function evaluationFromRow(
  row: typeof checkRegionalEvaluations.$inferSelect,
  executions: Map<string, typeof checkRegionalExecutions.$inferSelect>,
): RegionalEvaluationV1 {
  const evidence = (id: string | null) => {
    if (!id) return null;
    const item = executions.get(id);
    if (!item) throw new Error('Regional execution evidence is missing.');
    return {
      executionId: item.id,
      agentId: item.agentId,
      acceptedAt: item.acceptedAt.toISOString(),
      observation: item.observation,
    };
  };
  if (row.phase === 'AWAITING_PRIMARY') return initialRegionalEvaluation(row.location);
  if (row.phase === 'AWAITING_CONFIRMATION')
    return {
      phase: 'AWAITING_CONFIRMATION',
      locationId: row.location,
      primary: evidence(row.primaryExecutionId)!,
      confirmation: null,
    };
  return {
    phase: 'TERMINAL',
    locationId: row.location,
    outcome: row.outcome as 'PASS' | 'CONFIRMED_FAIL' | 'UNKNOWN',
    terminalReason: row.terminalReason as Extract<
      RegionalEvaluationV1,
      { phase: 'TERMINAL' }
    >['terminalReason'],
    primary: evidence(row.primaryExecutionId),
    confirmation: evidence(row.confirmationExecutionId),
  };
}

async function persistEvaluation(
  tx: Transaction,
  organizationId: string,
  roundId: string,
  state: RegionalEvaluationV1,
  at: Date,
) {
  await tx
    .update(checkRegionalEvaluations)
    .set({
      phase: state.phase,
      outcome: state.phase === 'TERMINAL' ? state.outcome : null,
      terminalReason: state.phase === 'TERMINAL' ? state.terminalReason : null,
      primaryExecutionId: state.primary?.executionId ?? null,
      confirmationExecutionId: state.confirmation?.executionId ?? null,
      updatedAt: at,
    })
    .where(
      and(
        eq(checkRegionalEvaluations.organizationId, organizationId),
        eq(checkRegionalEvaluations.roundId, roundId),
        eq(checkRegionalEvaluations.location, state.locationId),
      ),
    );
}

async function databaseNow(tx: Transaction): Promise<Date> {
  const result = await tx.execute<{ at: string }>(
    sql`select date_trunc('milliseconds', clock_timestamp()) as at`,
  );
  const at = result.rows[0]?.at;
  if (!at) throw new Error('Database finalization clock is unavailable.');
  return new Date(at);
}
