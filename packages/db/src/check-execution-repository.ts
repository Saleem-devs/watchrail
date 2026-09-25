import { and, eq, sql } from 'drizzle-orm';
import type { HttpMethod, HttpStatusPolicy, StoredRequestHeader } from '@watchrail/domain';
import type { WatchrailDatabase } from './client.js';
import {
  checkExecutionAssignments,
  checkExecutionResults,
  checkRounds,
  monitorConfigurationVersions,
  type CheckExecutionResultRecord,
} from './schema.js';

export interface ClaimedCheckExecution {
  assignmentId: string;
  claimToken: string;
  attemptNumber: number;
  url: string;
  method: HttpMethod;
  timeoutMs: number;
  statusPolicy: HttpStatusPolicy;
  organizationId: string;
  monitorId: string;
  requestHeaders: readonly StoredRequestHeader[];
}

export type CheckExecutionClaimResult =
  | { state: 'CLAIMED'; execution: ClaimedCheckExecution }
  | { state: 'BUSY' }
  | { state: 'COMPLETED' }
  | { state: 'MISSING' };

export interface AuthoritativeCheckResult {
  outcome: CheckExecutionResultRecord['outcome'];
  stage: CheckExecutionResultRecord['stage'];
  reason: CheckExecutionResultRecord['reason'];
  statusCode: number | null;
  responseTimeMs: number | null;
  attemptDurationMs: number;
  checkedAt: Date;
}

export class CheckExecutionRepository {
  constructor(private readonly db: WatchrailDatabase) {}

  async claim(roundId: string, leaseDurationMs: number): Promise<CheckExecutionClaimResult> {
    assertPositiveMilliseconds(leaseDurationMs, 'leaseDurationMs');

    return this.db.transaction(async (tx) => {
      const [candidate] = await tx
        .select({
          assignmentId: checkExecutionAssignments.id,
          status: checkExecutionAssignments.status,
          claimAvailable: sql<boolean>`
            ${checkExecutionAssignments.status} <> 'RUNNING'
            or ${checkExecutionAssignments.claimExpiresAt} <= now()
          `,
          attemptCount: checkExecutionAssignments.attemptCount,
          url: monitorConfigurationVersions.url,
          method: monitorConfigurationVersions.method,
          timeoutMs: monitorConfigurationVersions.timeoutMs,
          statusPolicy: monitorConfigurationVersions.statusPolicy,
          organizationId: monitorConfigurationVersions.organizationId,
          monitorId: monitorConfigurationVersions.monitorId,
          requestHeaders: monitorConfigurationVersions.requestHeaders,
        })
        .from(checkExecutionAssignments)
        .innerJoin(
          checkRounds,
          and(
            eq(checkRounds.id, checkExecutionAssignments.roundId),
            eq(checkRounds.organizationId, checkExecutionAssignments.organizationId),
          ),
        )
        .innerJoin(
          monitorConfigurationVersions,
          eq(monitorConfigurationVersions.id, checkRounds.monitorConfigurationVersionId),
        )
        .where(and(eq(checkRounds.id, roundId), eq(checkExecutionAssignments.location, 'local')))
        .limit(1)
        .for('update', { of: checkExecutionAssignments });

      if (!candidate) return { state: 'MISSING' };
      if (candidate.status === 'COMPLETED') return { state: 'COMPLETED' };

      if (candidate.status === 'RUNNING' && !candidate.claimAvailable) {
        return { state: 'BUSY' };
      }

      const [claimed] = await tx
        .update(checkExecutionAssignments)
        .set({
          status: 'RUNNING',
          claimToken: sql`gen_random_uuid()`,
          claimExpiresAt: sql`now() + (${leaseDurationMs} * interval '1 millisecond')`,
          attemptCount: candidate.attemptCount + 1,
          lastStartedAt: sql`now()`,
          completedAt: null,
        })
        .where(eq(checkExecutionAssignments.id, candidate.assignmentId))
        .returning({
          claimToken: checkExecutionAssignments.claimToken,
          attemptNumber: checkExecutionAssignments.attemptCount,
        });

      if (!claimed?.claimToken) {
        throw new Error('The execution claim update returned no token.');
      }

      return {
        state: 'CLAIMED',
        execution: {
          assignmentId: candidate.assignmentId,
          claimToken: claimed.claimToken,
          attemptNumber: claimed.attemptNumber,
          url: candidate.url,
          method: candidate.method,
          timeoutMs: candidate.timeoutMs,
          statusPolicy: candidate.statusPolicy,
          organizationId: candidate.organizationId,
          monitorId: candidate.monitorId,
          requestHeaders: candidate.requestHeaders,
        },
      };
    });
  }

  async complete(
    assignmentId: string,
    claimToken: string,
    result: AuthoritativeCheckResult,
  ): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      const [completed] = await tx
        .update(checkExecutionAssignments)
        .set({
          status: 'COMPLETED',
          claimToken: null,
          claimExpiresAt: null,
          completedAt: sql`now()`,
        })
        .where(
          and(
            eq(checkExecutionAssignments.id, assignmentId),
            eq(checkExecutionAssignments.status, 'RUNNING'),
            eq(checkExecutionAssignments.claimToken, claimToken),
          ),
        )
        .returning({
          organizationId: checkExecutionAssignments.organizationId,
          roundId: checkExecutionAssignments.roundId,
        });

      if (!completed) return false;

      await tx.insert(checkExecutionResults).values({
        organizationId: completed.organizationId,
        roundId: completed.roundId,
        assignmentId,
        outcome: result.outcome,
        stage: result.stage,
        reason: result.reason,
        statusCode: result.statusCode,
        responseTimeMs: result.responseTimeMs,
        attemptDurationMs: result.attemptDurationMs,
        checkedAt: result.checkedAt,
      });

      await tx
        .update(checkRounds)
        .set({ status: 'COMPLETED' })
        .where(eq(checkRounds.id, completed.roundId));

      return true;
    });
  }
}

function assertPositiveMilliseconds(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive safe integer.`);
  }
}
