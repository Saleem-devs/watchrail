import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, lte, sql } from 'drizzle-orm';
import {
  EMPTY_ASSERTION_EVALUATION,
  MULTI_LOCATION_AGGREGATION_POLICY_VERSION,
  MULTI_LOCATION_CONFIRMATION_POLICY_VERSION,
  MULTI_LOCATION_CONTRACT_VERSION,
  MULTI_LOCATION_ROUND_FINALIZATION_WINDOW_MS,
  redactHeartbeatSignal,
  type HeartbeatResultEvidenceV1,
  type HeartbeatSignal,
} from '@watchrail/domain';
import type { WatchrailDatabase } from './client.js';
import {
  finalizeCheckExecution,
  type AuthoritativeCheckResult,
} from './check-execution-repository.js';
import { nextHeartbeatDeadline } from './heartbeat-schedule.js';
import {
  checkExecutionAssignments,
  checkRoundLocations,
  checkRounds,
  heartbeatSignals,
  monitorConfigurationVersions,
  monitors,
} from './schema.js';

export class HeartbeatCredentialNotFoundError extends Error {}

export interface HeartbeatSignalReceipt {
  monitorId: string;
  receivedAt: Date;
  nextExpectedAt: Date | null;
  state: 'RECEIVED' | 'STARTED' | 'FAILED' | 'IGNORED';
}

export class HeartbeatRepository {
  constructor(
    private readonly db: WatchrailDatabase,
    private readonly createRoundId: () => string = randomUUID,
  ) {}

  async recordSignal(
    tokenHash: string,
    inputSignal: HeartbeatSignal,
  ): Promise<HeartbeatSignalReceipt> {
    const signal = redactHeartbeatSignal(inputSignal);
    return this.db.transaction(async (tx) => {
      const [monitor] = await tx
        .select()
        .from(monitors)
        .where(eq(monitors.heartbeatTokenHash, tokenHash))
        .limit(1)
        .for('update');
      if (!monitor || monitor.type !== 'HEARTBEAT' || !monitor.heartbeat) {
        throw new HeartbeatCredentialNotFoundError();
      }
      if (monitor.lifecycleState === 'ARCHIVED') throw new HeartbeatCredentialNotFoundError();

      const receivedAt = new Date();
      const expectedAt = expectedSignalAt(
        monitor.nextCheckAt,
        monitor.heartbeat.schedule.graceSeconds,
      );
      const deadlineOverdue =
        monitor.lifecycleState === 'ENABLED' &&
        monitor.nextCheckAt !== null &&
        monitor.nextCheckAt.getTime() < receivedAt.getTime();
      const activeRunAtReceipt = monitor.heartbeatLastStartedAt !== null;
      const runMatches = activeRunAtReceipt && monitor.heartbeatActiveRunId === signal.runId;
      const terminalSignal = signal.type === 'COMPLETE' || signal.type === 'FAIL';
      const terminalIsAuthoritative =
        terminalSignal &&
        !deadlineOverdue &&
        (runMatches || (!activeRunAtReceipt && monitor.heartbeat.maximumRuntimeSeconds === null));
      const signalIsAuthoritative =
        signal.type === 'PING' || signal.type === 'START' || terminalIsAuthoritative;
      const duplicateStart = signal.type === 'START' && runMatches && !deadlineOverdue;
      const runtimeMs =
        terminalIsAuthoritative && runMatches && monitor.heartbeatLastStartedAt
          ? Math.max(0, receivedAt.getTime() - monitor.heartbeatLastStartedAt.getTime())
          : null;

      let activeStartedAt = monitor.heartbeatLastStartedAt;
      let activeRunId = monitor.heartbeatActiveRunId;
      let nextDeadlineAt = monitor.nextCheckAt;

      if (deadlineOverdue) {
        nextDeadlineAt = await recordOverdueHeartbeat(
          tx,
          monitor,
          receivedAt,
          this.createRoundId(),
        );
        activeStartedAt = null;
        activeRunId = null;
      }

      if (signal.type === 'START' && !duplicateStart) {
        activeStartedAt = receivedAt;
        activeRunId = signal.runId;
      } else if (terminalIsAuthoritative) {
        activeStartedAt = null;
        activeRunId = null;
      }

      if (monitor.lifecycleState !== 'ENABLED') {
        nextDeadlineAt = null;
      } else if (signal.type === 'START' && duplicateStart) {
        nextDeadlineAt = monitor.nextCheckAt;
      } else if (signalIsAuthoritative) {
        nextDeadlineAt =
          activeStartedAt !== null && monitor.heartbeat.maximumRuntimeSeconds !== null
            ? new Date(
                activeStartedAt.getTime() +
                  (monitor.heartbeat.maximumRuntimeSeconds +
                    monitor.heartbeat.schedule.graceSeconds) *
                    1_000,
              )
            : nextHeartbeatDeadline(monitor.heartbeat.schedule, receivedAt);
      }

      await tx.insert(heartbeatSignals).values({
        organizationId: monitor.organizationId,
        monitorId: monitor.id,
        signalType: signal.type,
        runId: signal.runId,
        message: signal.message,
        metadata: signal.metadata,
        runtimeMs,
        receivedAt,
      });

      if (deadlineOverdue || signalIsAuthoritative) {
        await tx
          .update(monitors)
          .set({
            ...(signalIsAuthoritative
              ? {
                  heartbeatLastSignalAt: receivedAt,
                  heartbeatLastSignalType: signal.type,
                  heartbeatLastCompletedAt:
                    signal.type === 'COMPLETE' ? receivedAt : monitor.heartbeatLastCompletedAt,
                }
              : {}),
            heartbeatLastStartedAt: activeStartedAt,
            heartbeatActiveRunId: activeRunId,
            nextCheckAt: nextDeadlineAt,
            updatedAt: sql`clock_timestamp()`,
          })
          .where(
            and(eq(monitors.organizationId, monitor.organizationId), eq(monitors.id, monitor.id)),
          );
      }

      if (
        monitor.lifecycleState === 'ENABLED' &&
        (signal.type === 'PING' || terminalIsAuthoritative)
      ) {
        await createCompletedHeartbeatRound(
          tx,
          monitor.organizationId,
          monitor.id,
          {
            outcome: signal.type === 'FAIL' ? 'FAIL' : 'PASS',
            stage: 'HEARTBEAT',
            reason: signal.type === 'FAIL' ? 'HEARTBEAT_FAILED' : 'SIGNAL_RECEIVED',
            statusCode: null,
            responseTimeMs: null,
            attemptDurationMs: 0,
            redirects: [],
            assertionEvaluation: EMPTY_ASSERTION_EVALUATION,
            heartbeatResult: heartbeatEvidence(signal, expectedAt, receivedAt, runtimeMs),
            checkedAt: receivedAt,
          },
          this.createRoundId(),
        );
      }

      return {
        monitorId: monitor.id,
        receivedAt,
        nextExpectedAt: expectedSignalAt(nextDeadlineAt, monitor.heartbeat.schedule.graceSeconds),
        state: !signalIsAuthoritative
          ? 'IGNORED'
          : signal.type === 'START'
            ? 'STARTED'
            : signal.type === 'FAIL'
              ? 'FAILED'
              : 'RECEIVED',
      };
    });
  }

  async evaluateDue(batchSize: number): Promise<number> {
    if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 1_000) {
      throw new RangeError('Heartbeat batch size must be an integer from 1 to 1000.');
    }
    return this.db.transaction(async (tx) => {
      const due = await tx
        .select()
        .from(monitors)
        .where(
          and(
            eq(monitors.type, 'HEARTBEAT'),
            eq(monitors.lifecycleState, 'ENABLED'),
            lte(monitors.nextCheckAt, sql`clock_timestamp()`),
          ),
        )
        .orderBy(asc(monitors.nextCheckAt), asc(monitors.id))
        .limit(batchSize)
        .for('update', { skipLocked: true });

      const checkedAt = new Date();
      for (const monitor of due) {
        if (!monitor.heartbeat || !monitor.nextCheckAt) continue;
        const nextCheckAt = await recordOverdueHeartbeat(
          tx,
          monitor,
          checkedAt,
          this.createRoundId(),
        );
        await tx
          .update(monitors)
          .set({
            nextCheckAt,
            heartbeatActiveRunId: null,
            heartbeatLastStartedAt: null,
            updatedAt: sql`clock_timestamp()`,
          })
          .where(
            and(eq(monitors.organizationId, monitor.organizationId), eq(monitors.id, monitor.id)),
          );
      }
      return due.length;
    });
  }
}

async function recordOverdueHeartbeat(
  tx: Transaction,
  monitor: typeof monitors.$inferSelect,
  reconciledAt: Date,
  roundId: string,
): Promise<Date> {
  if (!monitor.heartbeat || !monitor.nextCheckAt) {
    throw new Error(
      'Heartbeat deadline reconciliation requires heartbeat settings and a deadline.',
    );
  }
  const runtimeExceeded =
    monitor.heartbeat.maximumRuntimeSeconds !== null && monitor.heartbeatLastStartedAt !== null;
  const deadlineAt = monitor.nextCheckAt;
  const expectedAt = expectedSignalAt(deadlineAt, monitor.heartbeat.schedule.graceSeconds);
  await createCompletedHeartbeatRound(
    tx,
    monitor.organizationId,
    monitor.id,
    {
      outcome: 'FAIL',
      stage: 'HEARTBEAT',
      reason: runtimeExceeded ? 'RUNTIME_EXCEEDED' : 'MISSED_HEARTBEAT',
      statusCode: null,
      responseTimeMs: null,
      attemptDurationMs: 0,
      redirects: [],
      assertionEvaluation: EMPTY_ASSERTION_EVALUATION,
      heartbeatResult: {
        contractVersion: 1,
        signal: 'MISSED',
        runId: monitor.heartbeatActiveRunId,
        message: null,
        metadata: {},
        expectedAt: expectedAt?.toISOString() ?? null,
        receivedAt: null,
        runtimeMs:
          runtimeExceeded && monitor.heartbeatLastStartedAt
            ? Math.max(0, deadlineAt.getTime() - monitor.heartbeatLastStartedAt.getTime())
            : null,
      },
      checkedAt: deadlineAt,
    },
    roundId,
  );
  return nextHeartbeatDeadline(monitor.heartbeat.schedule, reconciledAt);
}

function heartbeatEvidence(
  signal: HeartbeatSignal,
  expectedAt: Date | null,
  receivedAt: Date,
  runtimeMs: number | null,
): HeartbeatResultEvidenceV1 {
  return {
    contractVersion: 1,
    signal: signal.type,
    runId: signal.runId,
    message: signal.message,
    metadata: signal.metadata,
    expectedAt: expectedAt?.toISOString() ?? null,
    receivedAt: receivedAt.toISOString(),
    runtimeMs,
  };
}

function expectedSignalAt(deadline: Date | null, graceSeconds: number): Date | null {
  return deadline === null ? null : new Date(deadline.getTime() - graceSeconds * 1_000);
}

type Transaction = Parameters<Parameters<WatchrailDatabase['transaction']>[0]>[0];

async function createCompletedHeartbeatRound(
  tx: Transaction,
  organizationId: string,
  monitorId: string,
  result: AuthoritativeCheckResult,
  roundId: string,
): Promise<void> {
  const [configuration] = await tx
    .select({ id: monitorConfigurationVersions.id })
    .from(monitorConfigurationVersions)
    .where(
      and(
        eq(monitorConfigurationVersions.organizationId, organizationId),
        eq(monitorConfigurationVersions.monitorId, monitorId),
      ),
    )
    .orderBy(desc(monitorConfigurationVersions.versionNumber))
    .limit(1);
  if (!configuration) throw new Error('Heartbeat monitor has no configuration version.');

  const [round] = await tx
    .insert(checkRounds)
    .values({
      id: roundId,
      organizationId,
      monitorId,
      monitorConfigurationVersionId: configuration.id,
      trigger: 'SCHEDULED',
      status: 'PENDING',
      contractVersion: MULTI_LOCATION_CONTRACT_VERSION,
      aggregationPolicyVersion: MULTI_LOCATION_AGGREGATION_POLICY_VERSION,
      confirmationPolicyVersion: MULTI_LOCATION_CONFIRMATION_POLICY_VERSION,
      finalizationDeadlineAt: new Date(
        result.checkedAt.getTime() + MULTI_LOCATION_ROUND_FINALIZATION_WINDOW_MS,
      ),
      createdAt: result.checkedAt,
    })
    .returning({ id: checkRounds.id });
  if (!round) throw new Error('Heartbeat round insert returned no record.');

  await tx.insert(checkRoundLocations).values({
    organizationId,
    roundId: round.id,
    location: 'local',
    probeLocationId: null,
    position: 0,
  });
  const [assignment] = await tx
    .insert(checkExecutionAssignments)
    .values({
      organizationId,
      roundId: round.id,
      location: 'local',
      executionPolicyVersion: 'heartbeat-signal-v1',
      requiredEngineVersion: 'watchrail-heartbeat-v1',
      status: 'COMPLETED',
      attemptCount: 1,
      lastStartedAt: result.checkedAt,
      completedAt: result.checkedAt,
    })
    .returning({ id: checkExecutionAssignments.id });
  if (!assignment) throw new Error('Heartbeat assignment insert returned no record.');

  await finalizeCheckExecution(tx, {
    assignmentId: assignment.id,
    organizationId,
    roundId: round.id,
    result,
  });
}
