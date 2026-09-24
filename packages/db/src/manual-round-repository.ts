import { and, desc, eq } from 'drizzle-orm';
import { createExecuteCheckRoundJob } from '@watchrail/contracts';
import type { MonitorLifecycleState } from '@watchrail/domain';
import type { WatchrailDatabase } from './client.js';
import {
  checkExecutionAssignments,
  checkExecutionResults,
  checkRoundOutbox,
  checkRounds,
  monitorConfigurationVersions,
  monitors,
  type CheckExecutionAssignmentRecord,
  type CheckExecutionResultRecord,
  type CheckRoundRecord,
} from './schema.js';

export interface ManualRoundResult {
  id: string;
  monitorId: string;
  status: CheckRoundRecord['status'];
  assignmentStatus: CheckExecutionAssignmentRecord['status'];
  createdAt: Date;
  result: {
    outcome: CheckExecutionResultRecord['outcome'];
    stage: CheckExecutionResultRecord['stage'];
    reason: CheckExecutionResultRecord['reason'];
    statusCode: number | null;
    responseTimeMs: number | null;
    attemptDurationMs: number;
    checkedAt: Date;
  } | null;
}

export class MonitorNotFoundError extends Error {
  constructor() {
    super('Monitor not found.');
    this.name = 'MonitorNotFoundError';
  }
}

export class MonitorNotRunnableError extends Error {
  readonly lifecycleState: MonitorLifecycleState;

  constructor(lifecycleState: MonitorLifecycleState) {
    super(`Monitor cannot run while lifecycle state is ${lifecycleState}.`);

    this.name = 'MonitorNotRunnableError';
    this.lifecycleState = lifecycleState;
  }
}

export class MonitorConfigurationInvariantError extends Error {
  constructor() {
    super('Monitor has no configuration version.');
    this.name = 'MonitorConfigurationInvariantError';
  }
}

export class ManualRoundRepository {
  constructor(private readonly db: WatchrailDatabase) {}

  async create(organizationId: string, monitorId: string): Promise<CheckRoundRecord> {
    return this.db.transaction(async (tx) => {
      /*
       * Lock the monitor row.
       *
       * Any future configuration-update transaction should acquire this
       * same lock before appending its next configuration version. That gives
       * round creation a stable definition of "current configuration".
       */
      const [monitor] = await tx
        .select({
          id: monitors.id,
          lifecycleState: monitors.lifecycleState,
        })
        .from(monitors)
        .where(and(eq(monitors.id, monitorId), eq(monitors.organizationId, organizationId)))
        .limit(1)
        .for('update');

      if (!monitor) {
        throw new MonitorNotFoundError();
      }

      if (monitor.lifecycleState !== 'ENABLED') {
        throw new MonitorNotRunnableError(monitor.lifecycleState);
      }

      /*
       * Configuration versions are append-only.
       * Highest version_number is the current configuration.
       */
      const [configuration] = await tx
        .select({
          id: monitorConfigurationVersions.id,
        })
        .from(monitorConfigurationVersions)
        .where(
          and(
            eq(monitorConfigurationVersions.organizationId, organizationId),
            eq(monitorConfigurationVersions.monitorId, monitorId),
          ),
        )
        .orderBy(desc(monitorConfigurationVersions.versionNumber))
        .limit(1);

      if (!configuration) {
        throw new MonitorConfigurationInvariantError();
      }

      const [round] = await tx
        .insert(checkRounds)
        .values({
          organizationId,
          monitorId,

          monitorConfigurationVersionId: configuration.id,

          trigger: 'MANUAL',
          status: 'PENDING',
        })
        .returning();

      if (!round) {
        throw new Error('The check round insert returned no record.');
      }

      await tx.insert(checkExecutionAssignments).values({
        organizationId,
        roundId: round.id,

        location: 'local',
        status: 'PENDING',
      });

      const payload = createExecuteCheckRoundJob(round.id);

      await tx.insert(checkRoundOutbox).values({
        roundId: round.id,
        payload,
      });

      return round;
    });
  }

  async findForOrganization(
    organizationId: string,
    monitorId: string,
    roundId: string,
  ): Promise<ManualRoundResult | null> {
    const [round] = await this.db
      .select({
        id: checkRounds.id,
        monitorId: checkRounds.monitorId,
        status: checkRounds.status,
        assignmentStatus: checkExecutionAssignments.status,
        createdAt: checkRounds.createdAt,
        outcome: checkExecutionResults.outcome,
        stage: checkExecutionResults.stage,
        reason: checkExecutionResults.reason,
        statusCode: checkExecutionResults.statusCode,
        responseTimeMs: checkExecutionResults.responseTimeMs,
        attemptDurationMs: checkExecutionResults.attemptDurationMs,
        checkedAt: checkExecutionResults.checkedAt,
      })
      .from(checkRounds)
      .innerJoin(
        checkExecutionAssignments,
        and(
          eq(checkExecutionAssignments.organizationId, checkRounds.organizationId),
          eq(checkExecutionAssignments.roundId, checkRounds.id),
          eq(checkExecutionAssignments.location, 'local'),
        ),
      )
      .leftJoin(
        checkExecutionResults,
        and(
          eq(checkExecutionResults.organizationId, checkRounds.organizationId),
          eq(checkExecutionResults.roundId, checkRounds.id),
          eq(checkExecutionResults.assignmentId, checkExecutionAssignments.id),
        ),
      )
      .where(
        and(
          eq(checkRounds.organizationId, organizationId),
          eq(checkRounds.monitorId, monitorId),
          eq(checkRounds.id, roundId),
          eq(checkRounds.trigger, 'MANUAL'),
        ),
      )
      .limit(1);

    if (!round) return null;

    const result =
      round.outcome &&
      round.stage &&
      round.reason &&
      round.attemptDurationMs !== null &&
      round.checkedAt
        ? {
            outcome: round.outcome,
            stage: round.stage,
            reason: round.reason,
            statusCode: round.statusCode,
            responseTimeMs: round.responseTimeMs,
            attemptDurationMs: round.attemptDurationMs,
            checkedAt: round.checkedAt,
          }
        : null;

    return {
      id: round.id,
      monitorId: round.monitorId,
      status: round.status,
      assignmentStatus: round.assignmentStatus,
      createdAt: round.createdAt,
      result,
    };
  }
}
