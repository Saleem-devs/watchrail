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
  state: 'RECEIVED' | 'STARTED' | 'FAILED';
}

export class HeartbeatRepository {
  constructor(private readonly db: WatchrailDatabase) {}

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
      const startedAt = monitor.heartbeatLastStartedAt;
      const runMatches =
        startedAt !== null &&
        (signal.runId === null ||
          monitor.heartbeatActiveRunId === null ||
          monitor.heartbeatActiveRunId === signal.runId);
      const runtimeMs =
        (signal.type === 'COMPLETE' || signal.type === 'FAIL') && runMatches
          ? Math.max(0, receivedAt.getTime() - startedAt.getTime())
          : null;
      const activeStartedAt =
        signal.type === 'START'
          ? receivedAt
          : signal.type === 'COMPLETE' || signal.type === 'FAIL'
            ? null
            : monitor.heartbeatLastStartedAt;
      const nextDeadlineAt =
        monitor.lifecycleState !== 'ENABLED'
          ? null
          : activeStartedAt !== null && monitor.heartbeat.maximumRuntimeSeconds !== null
            ? new Date(
                activeStartedAt.getTime() +
                  (monitor.heartbeat.maximumRuntimeSeconds +
                    monitor.heartbeat.schedule.graceSeconds) *
                    1_000,
              )
            : nextHeartbeatDeadline(monitor.heartbeat.schedule, receivedAt);

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

      await tx
        .update(monitors)
        .set({
          heartbeatLastSignalAt: receivedAt,
          heartbeatLastSignalType: signal.type,
          heartbeatLastStartedAt:
            signal.type === 'START'
              ? receivedAt
              : signal.type === 'COMPLETE' || signal.type === 'FAIL'
                ? null
                : monitor.heartbeatLastStartedAt,
          heartbeatLastCompletedAt:
            signal.type === 'COMPLETE' ? receivedAt : monitor.heartbeatLastCompletedAt,
          heartbeatActiveRunId:
            signal.type === 'START'
              ? signal.runId
              : signal.type === 'COMPLETE' || signal.type === 'FAIL'
                ? null
                : monitor.heartbeatActiveRunId,
          nextCheckAt: nextDeadlineAt,
          updatedAt: sql`clock_timestamp()`,
        })
        .where(
          and(eq(monitors.organizationId, monitor.organizationId), eq(monitors.id, monitor.id)),
        );

      if (monitor.lifecycleState === 'ENABLED' && signal.type !== 'START') {
        await createCompletedHeartbeatRound(tx, monitor.organizationId, monitor.id, {
          outcome: signal.type === 'FAIL' ? 'FAIL' : 'PASS',
          stage: 'HEARTBEAT',
          reason: signal.type === 'FAIL' ? 'HEARTBEAT_FAILED' : 'SIGNAL_RECEIVED',
          statusCode: null,
          responseTimeMs: null,
          attemptDurationMs: 0,
          redirects: [],
          assertionEvaluation: EMPTY_ASSERTION_EVALUATION,
          heartbeatResult: heartbeatEvidence(
            signal,
            expectedSignalAt(monitor.nextCheckAt, monitor.heartbeat.schedule.graceSeconds),
            receivedAt,
            runtimeMs,
          ),
          checkedAt: receivedAt,
        });
      }

      return {
        monitorId: monitor.id,
        receivedAt,
        nextExpectedAt: expectedSignalAt(nextDeadlineAt, monitor.heartbeat.schedule.graceSeconds),
        state: signal.type === 'START' ? 'STARTED' : signal.type === 'FAIL' ? 'FAILED' : 'RECEIVED',
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
        const runtimeExceeded =
          monitor.heartbeat.maximumRuntimeSeconds !== null &&
          monitor.heartbeatLastStartedAt !== null;
        const reason = runtimeExceeded ? 'RUNTIME_EXCEEDED' : 'MISSED_HEARTBEAT';
        const expectedAt = expectedSignalAt(
          monitor.nextCheckAt,
          monitor.heartbeat.schedule.graceSeconds,
        );
        await createCompletedHeartbeatRound(tx, monitor.organizationId, monitor.id, {
          outcome: 'FAIL',
          stage: 'HEARTBEAT',
          reason,
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
                ? Math.max(0, checkedAt.getTime() - monitor.heartbeatLastStartedAt.getTime())
                : null,
          },
          checkedAt,
        });
        await tx
          .update(monitors)
          .set({
            nextCheckAt: nextHeartbeatDeadline(monitor.heartbeat.schedule, checkedAt),
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
