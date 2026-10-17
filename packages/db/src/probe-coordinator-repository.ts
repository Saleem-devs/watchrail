import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { and, asc, eq, getTableColumns, lte, or, sql } from 'drizzle-orm';
import type { ProbeLeaseReferenceV1, ProbeResultSubmissionReferenceV1 } from '@watchrail/contracts';
import {
  EMPTY_ASSERTION_EVALUATION,
  PROBE_LEASE_DURATION_MS,
  PROBE_MAX_ATTEMPTS,
  PROBE_MAX_EXECUTION_MS,
  PROBE_RESULT_CLOCK_SKEW_MS,
} from '@watchrail/domain';
import type { WatchrailDatabase } from './client.js';
import {
  finalizeCheckExecution,
  type AuthoritativeCheckResult,
} from './check-execution-repository.js';
import { recordRegionalExecution } from './multi-location-finalization-repository.js';
import type { ProbeMachineIdentity } from './probe-identity-repository.js';
import {
  checkExecutionAssignments,
  checkExecutionResults,
  checkRegionalEvaluations,
  checkRegionalExecutions,
  checkRoundLocations,
  checkRounds,
  monitorConfigurationVersions,
  probeAgentCredentials,
  probeAgents,
  probeExecutionAttempts,
  probeLocations,
} from './schema.js';

type Transaction = Parameters<Parameters<WatchrailDatabase['transaction']>[0]>[0];

export type ProbeLeaseClaimResult =
  { state: 'CLAIMED'; lease: ProbeLeaseReferenceV1 } | { state: 'NO_WORK' };

export type ProbeSubmissionResult =
  | { state: 'ACCEPTED'; duplicate: boolean }
  | {
      state: 'REJECTED';
      reason:
        | 'ASSIGNMENT_NOT_FOUND'
        | 'ATTEMPT_NOT_FOUND'
        | 'CLAIM_TOKEN_MISMATCH'
        | 'NON_AUTHORITATIVE_LEASE'
        | 'REPLAY_MISMATCH'
        | 'RESULT_TIMESTAMP_OUT_OF_RANGE';
    };

export interface ProbeExecutionConfigurationRecord {
  assignmentId: string;
  attemptId: string;
  configurationVersionId: string;
  configurationVersionNumber: number;
  executionPolicyVersion: string;
  requiredEngineVersion: string;
  organizationId: string;
  monitorId: string;
  url: string;
  method: string;
  timeoutMs: number;
  followRedirects: boolean;
  statusPolicy: unknown;
  requestHeaders: unknown;
  assertions: unknown;
}

export class ProbeCoordinatorRepository {
  constructor(
    private readonly db: WatchrailDatabase,
    private readonly multiLocationExecutionEnabled = false,
  ) {}

  async heartbeat(
    machine: ProbeMachineIdentity,
    engineVersion: string,
    heartbeatIntervalMs = 15_000,
  ): Promise<Date> {
    return this.db.transaction(async (tx) => {
      await lockActiveMachine(tx, machine);
      const [updated] = await tx
        .update(probeAgents)
        .set({
          engineVersion,
          heartbeatIntervalMs,
          lastHeartbeatAt: sql`clock_timestamp()`,
          updatedAt: sql`clock_timestamp()`,
        })
        .where(eq(probeAgents.id, machine.agentId))
        .returning({ lastHeartbeatAt: probeAgents.lastHeartbeatAt });
      if (!updated?.lastHeartbeatAt) throw new Error('Probe heartbeat update returned no time.');
      return updated.lastHeartbeatAt;
    });
  }

  async configuration(
    machine: ProbeMachineIdentity,
    attemptId: string,
    claimToken: string,
  ): Promise<ProbeExecutionConfigurationRecord | null> {
    return this.db.transaction(async (tx) => {
      await lockActiveMachine(tx, machine);
      if (!(await lockPendingRoundForAttempt(tx, machine, attemptId))) return null;
      const [row] = await tx
        .select({
          assignmentId: checkExecutionAssignments.id,
          attemptId: probeExecutionAttempts.id,
          attemptNumber: probeExecutionAttempts.attemptNumber,
          attemptStatus: probeExecutionAttempts.status,
          attemptUnexpired: sql<boolean>`${probeExecutionAttempts.leaseExpiresAt} > clock_timestamp()`,
          claimTokenVerifier: probeExecutionAttempts.claimTokenVerifier,
          assignmentStatus: checkExecutionAssignments.status,
          assignmentAttemptCount: checkExecutionAssignments.attemptCount,
          assignmentUnexpired: sql<boolean>`${checkExecutionAssignments.claimExpiresAt} > clock_timestamp()`,
          configurationVersionId: monitorConfigurationVersions.id,
          configurationVersionNumber: monitorConfigurationVersions.versionNumber,
          executionPolicyVersion: checkExecutionAssignments.executionPolicyVersion,
          requiredEngineVersion: checkExecutionAssignments.requiredEngineVersion,
          organizationId: monitorConfigurationVersions.organizationId,
          monitorId: monitorConfigurationVersions.monitorId,
          url: monitorConfigurationVersions.url,
          method: monitorConfigurationVersions.method,
          timeoutMs: monitorConfigurationVersions.timeoutMs,
          followRedirects: monitorConfigurationVersions.followRedirects,
          statusPolicy: monitorConfigurationVersions.statusPolicy,
          requestHeaders: monitorConfigurationVersions.requestHeaders,
          assertions: monitorConfigurationVersions.assertions,
        })
        .from(probeExecutionAttempts)
        .innerJoin(
          checkExecutionAssignments,
          and(
            eq(checkExecutionAssignments.organizationId, probeExecutionAttempts.organizationId),
            eq(checkExecutionAssignments.id, probeExecutionAttempts.assignmentId),
          ),
        )
        .innerJoin(
          checkRounds,
          and(
            eq(checkRounds.organizationId, checkExecutionAssignments.organizationId),
            eq(checkRounds.id, checkExecutionAssignments.roundId),
          ),
        )
        .innerJoin(
          monitorConfigurationVersions,
          eq(monitorConfigurationVersions.id, checkRounds.monitorConfigurationVersionId),
        )
        .where(
          and(
            eq(probeExecutionAttempts.organizationId, machine.organizationId),
            eq(probeExecutionAttempts.id, attemptId),
            eq(probeExecutionAttempts.agentId, machine.agentId),
            eq(probeExecutionAttempts.locationId, machine.locationId),
          ),
        )
        .limit(1)
        .for('update', { of: checkExecutionAssignments });
      if (
        !row ||
        row.attemptStatus !== 'LEASED' ||
        !row.attemptUnexpired ||
        row.claimTokenVerifier !== verifier(claimToken) ||
        row.assignmentStatus !== 'RUNNING' ||
        !row.assignmentUnexpired ||
        row.assignmentAttemptCount !== row.attemptNumber
      ) {
        return null;
      }
      return {
        assignmentId: row.assignmentId,
        attemptId: row.attemptId,
        configurationVersionId: row.configurationVersionId,
        configurationVersionNumber: row.configurationVersionNumber,
        executionPolicyVersion: row.executionPolicyVersion,
        requiredEngineVersion: row.requiredEngineVersion,
        organizationId: row.organizationId,
        monitorId: row.monitorId,
        url: row.url,
        method: row.method,
        timeoutMs: row.timeoutMs,
        followRedirects: row.followRedirects,
        statusPolicy: row.statusPolicy,
        requestHeaders: row.requestHeaders,
        assertions: row.assertions,
      };
    });
  }

  async claim(
    machine: ProbeMachineIdentity,
    engineVersion: string,
    pendingTimeoutMs = 120_000,
  ): Promise<ProbeLeaseClaimResult> {
    validatePendingTimeout(pendingTimeoutMs);
    return this.db.transaction(async (tx) => {
      await lockActiveMachine(tx, machine);

      const [candidate] = await tx
        .select({
          assignmentId: checkExecutionAssignments.id,
          roundId: checkExecutionAssignments.roundId,
          location: checkExecutionAssignments.location,
          status: checkExecutionAssignments.status,
          attemptCount: checkExecutionAssignments.attemptCount,
          executionPolicyVersion: checkExecutionAssignments.executionPolicyVersion,
          requiredEngineVersion: checkExecutionAssignments.requiredEngineVersion,
          configurationVersionId: checkRounds.monitorConfigurationVersionId,
          configurationVersionNumber: monitorConfigurationVersions.versionNumber,
        })
        .from(checkExecutionAssignments)
        .innerJoin(
          checkRounds,
          and(
            eq(checkRounds.organizationId, checkExecutionAssignments.organizationId),
            eq(checkRounds.id, checkExecutionAssignments.roundId),
          ),
        )
        .innerJoin(
          monitorConfigurationVersions,
          eq(monitorConfigurationVersions.id, checkRounds.monitorConfigurationVersionId),
        )
        .where(
          and(
            eq(checkExecutionAssignments.organizationId, machine.organizationId),
            eq(checkExecutionAssignments.probeLocationId, machine.locationId),
            eq(checkRounds.status, 'PENDING'),
            sql`${checkRounds.finalizationDeadlineAt} > clock_timestamp()`,
            or(
              and(
                eq(checkExecutionAssignments.status, 'PENDING'),
                sql`${checkExecutionAssignments.pendingSince} > clock_timestamp() - (${pendingTimeoutMs} * interval '1 millisecond')`,
              ),
              and(
                eq(checkExecutionAssignments.status, 'RUNNING'),
                lte(checkExecutionAssignments.claimExpiresAt, sql`clock_timestamp()`),
              ),
            ),
            lte(checkExecutionAssignments.attemptCount, PROBE_MAX_ATTEMPTS - 1),
            eq(checkExecutionAssignments.requiredEngineVersion, engineVersion),
          ),
        )
        .orderBy(asc(checkExecutionAssignments.createdAt), asc(checkExecutionAssignments.id))
        .limit(1)
        .for('update', { of: checkExecutionAssignments, skipLocked: true });

      if (!candidate) return { state: 'NO_WORK' };

      const locationCount = await roundLocationCount(tx, machine.organizationId, candidate.roundId);
      if (locationCount > 1 && !this.multiLocationExecutionEnabled) return { state: 'NO_WORK' };
      if (
        locationCount > 1 &&
        (await shouldWaitForDifferentConfirmationAgent(
          tx,
          machine,
          candidate.roundId,
          candidate.requiredEngineVersion,
        ))
      ) {
        return { state: 'NO_WORK' };
      }

      if (candidate.status === 'RUNNING') {
        await expireLeasedAttempt(tx, machine.organizationId, candidate.assignmentId);
      }

      const claimToken = randomBytes(32).toString('base64url');
      const claimTokenVerifier = verifier(claimToken);
      const assignmentClaimToken = randomUUID();
      const attemptNumber = candidate.attemptCount + 1;
      const [attempt] = await tx
        .insert(probeExecutionAttempts)
        .values({
          organizationId: machine.organizationId,
          assignmentId: candidate.assignmentId,
          locationId: machine.locationId,
          agentId: machine.agentId,
          attemptNumber,
          claimTokenVerifier,
          leasedAt: sql`clock_timestamp()`,
          leaseExpiresAt: sql`clock_timestamp() + (${PROBE_LEASE_DURATION_MS} * interval '1 millisecond')`,
        })
        .returning({
          id: probeExecutionAttempts.id,
          leaseExpiresAt: probeExecutionAttempts.leaseExpiresAt,
        });
      if (!attempt) throw new Error('Probe attempt insert returned no record.');

      await tx
        .update(checkExecutionAssignments)
        .set({
          status: 'RUNNING',
          claimToken: assignmentClaimToken,
          claimExpiresAt: attempt.leaseExpiresAt,
          attemptCount: attemptNumber,
          lastStartedAt: sql`clock_timestamp()`,
        })
        .where(eq(checkExecutionAssignments.id, candidate.assignmentId));

      return {
        state: 'CLAIMED',
        lease: {
          contractVersion: 1,
          organizationId: machine.organizationId,
          locationId: machine.locationId,
          assignmentId: candidate.assignmentId,
          attemptId: attempt.id,
          attemptNumber,
          claimToken,
          configurationVersionId: candidate.configurationVersionId,
          configurationVersionNumber: candidate.configurationVersionNumber,
          executionPolicyVersion: candidate.executionPolicyVersion,
          requiredEngineVersion: candidate.requiredEngineVersion,
          leaseExpiresAt: attempt.leaseExpiresAt.toISOString(),
        },
      };
    });
  }

  async renew(
    machine: ProbeMachineIdentity,
    reference: ProbeResultSubmissionReferenceV1,
    claimToken: string,
  ): Promise<Date | null> {
    return this.db.transaction(async (tx) => {
      await lockActiveMachine(tx, machine);
      const round = await lockRoundForAssignment(tx, machine, reference.assignmentId);
      if (!round?.acceptingWork) return null;
      const assignment = await lockAssignment(tx, machine, reference.assignmentId);
      if (!assignment || assignment.status !== 'RUNNING') return null;
      const attempt = await lockAttempt(tx, machine, reference);
      if (!isAuthoritativeAttempt(attempt, reference, claimToken, assignment)) return null;
      const [renewed] = await tx
        .update(probeExecutionAttempts)
        .set({
          leaseExpiresAt: sql`least(
            ${probeExecutionAttempts.leasedAt} + (${PROBE_MAX_EXECUTION_MS} * interval '1 millisecond'),
            clock_timestamp() + (${PROBE_LEASE_DURATION_MS} * interval '1 millisecond')
          )`,
          updatedAt: sql`clock_timestamp()`,
        })
        .where(eq(probeExecutionAttempts.id, reference.attemptId))
        .returning({ leaseExpiresAt: probeExecutionAttempts.leaseExpiresAt });
      if (!renewed) return null;
      await tx
        .update(checkExecutionAssignments)
        .set({ claimExpiresAt: renewed.leaseExpiresAt })
        .where(eq(checkExecutionAssignments.id, reference.assignmentId));
      return renewed.leaseExpiresAt;
    });
  }

  async submit(
    machine: ProbeMachineIdentity,
    reference: ProbeResultSubmissionReferenceV1,
    claimToken: string,
    result: AuthoritativeCheckResult,
  ): Promise<ProbeSubmissionResult> {
    return this.db.transaction(async (tx) => {
      await lockActiveMachine(tx, machine);
      if (!(await lockRoundForAssignment(tx, machine, reference.assignmentId))) {
        return { state: 'REJECTED', reason: 'ASSIGNMENT_NOT_FOUND' };
      }
      const assignment = await lockAssignment(tx, machine, reference.assignmentId);
      if (!assignment) return { state: 'REJECTED', reason: 'ASSIGNMENT_NOT_FOUND' };
      const attempt = await lockAttempt(tx, machine, reference);
      if (!attempt) return { state: 'REJECTED', reason: 'ATTEMPT_NOT_FOUND' };
      if (attempt.claimTokenVerifier !== verifier(claimToken)) {
        return { state: 'REJECTED', reason: 'CLAIM_TOKEN_MISMATCH' };
      }

      const locationCount = await roundLocationCount(
        tx,
        machine.organizationId,
        assignment.roundId,
      );
      if (locationCount > 1 && attempt.status === 'SUBMITTED') {
        const [storedExecution] = await tx
          .select({ role: checkRegionalExecutions.role })
          .from(checkRegionalExecutions)
          .where(eq(checkRegionalExecutions.id, attempt.id))
          .limit(1);
        if (!storedExecution) return { state: 'REJECTED', reason: 'REPLAY_MISMATCH' };
        const replay = await recordRegionalExecution(tx, {
          organizationId: machine.organizationId,
          roundId: assignment.roundId,
          assignmentId: assignment.id,
          location: assignment.location,
          executionId: attempt.id,
          agentId: machine.agentId,
          role: storedExecution.role as 'PRIMARY' | 'CONFIRMATION',
          observation: observationFromResult(result),
          diagnosticSummary: diagnosticSummaryFromResult(result),
          resultDigest: resultDigest(result),
        });
        return replay.state === 'DUPLICATE'
          ? { state: 'ACCEPTED', duplicate: true }
          : { state: 'REJECTED', reason: 'REPLAY_MISMATCH' };
      }

      if (attempt.status === 'SUBMITTED' && assignment.status === 'COMPLETED') {
        const [stored] = await tx
          .select()
          .from(checkExecutionResults)
          .where(eq(checkExecutionResults.assignmentId, assignment.id))
          .limit(1);
        return stored && sameResult(stored, result)
          ? { state: 'ACCEPTED', duplicate: true }
          : { state: 'REJECTED', reason: 'REPLAY_MISMATCH' };
      }

      if (!isAuthoritativeAttempt(attempt, reference, claimToken, assignment)) {
        return { state: 'REJECTED', reason: 'NON_AUTHORITATIVE_LEASE' };
      }
      const acceptedAt = await databaseClock(tx);
      if (
        result.checkedAt.getTime() < attempt.leasedAt.getTime() - PROBE_RESULT_CLOCK_SKEW_MS ||
        result.checkedAt.getTime() > acceptedAt.getTime() + PROBE_RESULT_CLOCK_SKEW_MS
      ) {
        return { state: 'REJECTED', reason: 'RESULT_TIMESTAMP_OUT_OF_RANGE' };
      }

      if (locationCount > 1) {
        if (!this.multiLocationExecutionEnabled) {
          return { state: 'REJECTED', reason: 'NON_AUTHORITATIVE_LEASE' };
        }
        const role = await regionalExecutionRole(
          tx,
          machine.organizationId,
          assignment.roundId,
          assignment.location,
        );
        const acceptance = await recordRegionalExecution(tx, {
          organizationId: machine.organizationId,
          roundId: assignment.roundId,
          assignmentId: assignment.id,
          location: assignment.location,
          executionId: attempt.id,
          agentId: machine.agentId,
          role,
          observation: observationFromResult(result),
          diagnosticSummary: diagnosticSummaryFromResult(result),
          resultDigest: resultDigest(result),
        });
        if (acceptance.state === 'REJECTED') {
          return { state: 'REJECTED', reason: 'NON_AUTHORITATIVE_LEASE' };
        }
        await tx
          .update(probeExecutionAttempts)
          .set({
            status: 'SUBMITTED',
            submittedAt: acceptedAt,
            submittedEngineVersion: reference.engineVersion,
            terminalReason: null,
            updatedAt: acceptedAt,
          })
          .where(eq(probeExecutionAttempts.id, attempt.id));
        if (!acceptance.roundFinalized) {
          if (acceptance.evaluation.phase === 'AWAITING_CONFIRMATION') {
            await tx
              .update(checkExecutionAssignments)
              .set({
                status: 'PENDING',
                claimToken: null,
                claimExpiresAt: null,
                pendingSince: acceptedAt,
                completedAt: null,
              })
              .where(eq(checkExecutionAssignments.id, assignment.id));
          } else {
            await tx
              .update(checkExecutionAssignments)
              .set({
                status: 'COMPLETED',
                claimToken: null,
                claimExpiresAt: null,
                completedAt: acceptedAt,
              })
              .where(eq(checkExecutionAssignments.id, assignment.id));
          }
        }
        return { state: 'ACCEPTED', duplicate: acceptance.state === 'DUPLICATE' };
      }

      await tx
        .update(probeExecutionAttempts)
        .set({
          status: 'SUBMITTED',
          submittedAt: sql`clock_timestamp()`,
          submittedEngineVersion: reference.engineVersion,
          terminalReason: null,
          updatedAt: sql`clock_timestamp()`,
        })
        .where(eq(probeExecutionAttempts.id, attempt.id));
      await tx
        .update(checkExecutionAssignments)
        .set({
          status: 'COMPLETED',
          claimToken: null,
          claimExpiresAt: null,
          completedAt: sql`clock_timestamp()`,
        })
        .where(eq(checkExecutionAssignments.id, assignment.id));
      await finalizeCheckExecution(tx, {
        assignmentId: assignment.id,
        organizationId: assignment.organizationId,
        roundId: assignment.roundId,
        result,
      });
      return { state: 'ACCEPTED', duplicate: false };
    });
  }

  async reconcileExpired(limit: number, pendingTimeoutMs = 120_000): Promise<number> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000)
      throw new RangeError('Invalid limit.');
    validatePendingTimeout(pendingTimeoutMs);
    return this.db.transaction(async (tx) => {
      const abandoned = await tx
        .select({ id: checkExecutionAssignments.id })
        .from(checkExecutionAssignments)
        .where(
          and(
            eq(checkExecutionAssignments.status, 'PENDING'),
            sql`${checkExecutionAssignments.probeLocationId} is not null`,
            sql`(
              select count(*)
              from ${checkRoundLocations}
              where ${checkRoundLocations.organizationId} = ${checkExecutionAssignments.organizationId}
                and ${checkRoundLocations.roundId} = ${checkExecutionAssignments.roundId}
            ) = 1`,
            sql`${checkExecutionAssignments.pendingSince} <= clock_timestamp() - (${pendingTimeoutMs} * interval '1 millisecond')`,
          ),
        )
        .orderBy(asc(checkExecutionAssignments.pendingSince), asc(checkExecutionAssignments.id))
        .limit(limit)
        .for('update', { of: checkExecutionAssignments, skipLocked: true });

      for (const row of abandoned) {
        const [assignment] = await tx
          .update(checkExecutionAssignments)
          .set({ status: 'COMPLETED', completedAt: sql`clock_timestamp()` })
          .where(
            and(
              eq(checkExecutionAssignments.id, row.id),
              eq(checkExecutionAssignments.status, 'PENDING'),
            ),
          )
          .returning();
        if (!assignment) continue;
        await finalizeCheckExecution(tx, {
          assignmentId: assignment.id,
          organizationId: assignment.organizationId,
          roundId: assignment.roundId,
          result: {
            outcome: 'UNKNOWN',
            stage: 'PROBE',
            reason: 'INTERNAL_ERROR',
            statusCode: null,
            responseTimeMs: null,
            attemptDurationMs: 0,
            redirects: [],
            assertionEvaluation: EMPTY_ASSERTION_EVALUATION,
            checkedAt: await databaseClock(tx),
          },
        });
      }

      const expired = await tx
        .select({ id: checkExecutionAssignments.id })
        .from(checkExecutionAssignments)
        .where(
          and(
            eq(checkExecutionAssignments.status, 'RUNNING'),
            lte(checkExecutionAssignments.claimExpiresAt, sql`clock_timestamp()`),
            sql`${checkExecutionAssignments.probeLocationId} is not null`,
            sql`(
              select count(*)
              from ${checkRoundLocations}
              where ${checkRoundLocations.organizationId} = ${checkExecutionAssignments.organizationId}
                and ${checkRoundLocations.roundId} = ${checkExecutionAssignments.roundId}
            ) = 1`,
          ),
        )
        .orderBy(asc(checkExecutionAssignments.claimExpiresAt), asc(checkExecutionAssignments.id))
        .limit(limit)
        .for('update', { of: checkExecutionAssignments, skipLocked: true });

      for (const row of expired) {
        const [assignment] = await tx
          .select()
          .from(checkExecutionAssignments)
          .where(eq(checkExecutionAssignments.id, row.id))
          .limit(1);
        if (!assignment || assignment.status !== 'RUNNING') continue;
        const [attempt] = await tx
          .select()
          .from(probeExecutionAttempts)
          .where(
            and(
              eq(probeExecutionAttempts.assignmentId, assignment.id),
              eq(probeExecutionAttempts.status, 'LEASED'),
            ),
          )
          .limit(1)
          .for('update', { of: probeExecutionAttempts });
        if (!attempt) continue;
        await tx
          .update(probeExecutionAttempts)
          .set({
            status: 'EXPIRED',
            terminalReason: 'LEASE_EXPIRED',
            updatedAt: sql`clock_timestamp()`,
          })
          .where(eq(probeExecutionAttempts.id, attempt.id));
        if (assignment.attemptCount < PROBE_MAX_ATTEMPTS) {
          await tx
            .update(checkExecutionAssignments)
            .set({
              status: 'PENDING',
              claimToken: null,
              claimExpiresAt: null,
              pendingSince: sql`clock_timestamp()`,
            })
            .where(eq(checkExecutionAssignments.id, assignment.id));
          continue;
        }
        const checkedAt = await databaseClock(tx);
        await tx
          .update(checkExecutionAssignments)
          .set({
            status: 'COMPLETED',
            claimToken: null,
            claimExpiresAt: null,
            completedAt: sql`clock_timestamp()`,
          })
          .where(eq(checkExecutionAssignments.id, assignment.id));
        await finalizeCheckExecution(tx, {
          assignmentId: assignment.id,
          organizationId: assignment.organizationId,
          roundId: assignment.roundId,
          result: {
            outcome: 'UNKNOWN',
            stage: 'PROBE',
            reason: 'INTERNAL_ERROR',
            statusCode: null,
            responseTimeMs: null,
            attemptDurationMs: 0,
            redirects: [],
            assertionEvaluation: EMPTY_ASSERTION_EVALUATION,
            checkedAt,
          },
        });
      }
      return abandoned.length + expired.length;
    });
  }
}

function validatePendingTimeout(pendingTimeoutMs: number): void {
  if (
    !Number.isSafeInteger(pendingTimeoutMs) ||
    pendingTimeoutMs < 10_000 ||
    pendingTimeoutMs > 900_000
  ) {
    throw new RangeError('Invalid pending assignment timeout.');
  }
}

async function roundLocationCount(
  tx: Transaction,
  organizationId: string,
  roundId: string,
): Promise<number> {
  const result = await tx.execute<{ count: string }>(sql`
    select count(*)::text as count
    from ${checkRoundLocations}
    where ${checkRoundLocations.organizationId} = ${organizationId}
      and ${checkRoundLocations.roundId} = ${roundId}
  `);
  return Number(result.rows[0]?.count ?? 0);
}

async function regionalExecutionRole(
  tx: Transaction,
  organizationId: string,
  roundId: string,
  location: string,
): Promise<'PRIMARY' | 'CONFIRMATION'> {
  const [evaluation] = await tx
    .select({ phase: checkRegionalEvaluations.phase })
    .from(checkRegionalEvaluations)
    .where(
      and(
        eq(checkRegionalEvaluations.organizationId, organizationId),
        eq(checkRegionalEvaluations.roundId, roundId),
        eq(checkRegionalEvaluations.location, location),
      ),
    )
    .limit(1);
  return evaluation?.phase === 'AWAITING_CONFIRMATION' ? 'CONFIRMATION' : 'PRIMARY';
}

async function shouldWaitForDifferentConfirmationAgent(
  tx: Transaction,
  machine: ProbeMachineIdentity,
  roundId: string,
  requiredEngineVersion: string,
): Promise<boolean> {
  const [primary] = await tx
    .select({ agentId: checkRegionalExecutions.agentId })
    .from(checkRegionalEvaluations)
    .innerJoin(
      checkRegionalExecutions,
      eq(checkRegionalExecutions.id, checkRegionalEvaluations.primaryExecutionId),
    )
    .where(
      and(
        eq(checkRegionalEvaluations.organizationId, machine.organizationId),
        eq(checkRegionalEvaluations.roundId, roundId),
        eq(checkRegionalEvaluations.location, machine.locationId),
        eq(checkRegionalEvaluations.phase, 'AWAITING_CONFIRMATION'),
      ),
    )
    .limit(1);
  if (!primary || primary.agentId !== machine.agentId) return false;
  const [alternative] = await tx
    .select({ id: probeAgents.id })
    .from(probeAgents)
    .where(
      and(
        eq(probeAgents.organizationId, machine.organizationId),
        eq(probeAgents.locationId, machine.locationId),
        eq(probeAgents.status, 'ACTIVE'),
        eq(probeAgents.engineVersion, requiredEngineVersion),
        sql`${probeAgents.id} <> ${machine.agentId}`,
        sql`${probeAgents.lastHeartbeatAt} is not null`,
        sql`${probeAgents.lastHeartbeatAt} >= clock_timestamp() - (${probeAgents.heartbeatIntervalMs} * 2 * interval '1 millisecond')`,
        sql`exists (
          select 1 from ${probeAgentCredentials}
          where ${probeAgentCredentials.organizationId} = ${probeAgents.organizationId}
            and ${probeAgentCredentials.agentId} = ${probeAgents.id}
            and ${probeAgentCredentials.status} = 'ACTIVE'
        )`,
      ),
    )
    .limit(1);
  return Boolean(alternative);
}

function observationFromResult(result: AuthoritativeCheckResult) {
  return {
    outcome: result.outcome,
    reason: result.reason,
    assertionOutcome: result.assertionEvaluation.outcome,
  } as const;
}

function diagnosticSummaryFromResult(result: AuthoritativeCheckResult) {
  return {
    stage: result.stage,
    reason: result.reason,
    statusCode: result.statusCode,
    responseTimeMs: result.responseTimeMs,
    attemptDurationMs: result.attemptDurationMs,
    checkedAt: result.checkedAt.toISOString(),
  } as const;
}

function resultDigest(result: AuthoritativeCheckResult): string {
  return createHash('sha256')
    .update(
      canonicalJson({
        ...result,
        checkedAt: result.checkedAt.toISOString(),
      }),
    )
    .digest('hex');
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(',')}}`;
}

async function lockActiveMachine(tx: Transaction, machine: ProbeMachineIdentity): Promise<void> {
  const [agent] = await tx
    .select({ status: probeAgents.status })
    .from(probeAgents)
    .where(
      and(
        eq(probeAgents.organizationId, machine.organizationId),
        eq(probeAgents.id, machine.agentId),
        eq(probeAgents.locationId, machine.locationId),
      ),
    )
    .limit(1)
    .for('update', { of: probeAgents });
  if (!agent || agent.status !== 'ACTIVE') throw new Error('PROBE_AUTH');
  const [credential] = await tx
    .select({ status: probeAgentCredentials.status, version: probeAgentCredentials.versionNumber })
    .from(probeAgentCredentials)
    .where(
      and(
        eq(probeAgentCredentials.organizationId, machine.organizationId),
        eq(probeAgentCredentials.id, machine.credentialId),
        eq(probeAgentCredentials.agentId, machine.agentId),
      ),
    )
    .limit(1)
    .for('update', { of: probeAgentCredentials });
  if (
    !credential ||
    credential.status !== 'ACTIVE' ||
    credential.version !== machine.credentialVersion
  ) {
    throw new Error('PROBE_AUTH');
  }
  const [location] = await tx
    .select({ status: probeLocations.status })
    .from(probeLocations)
    .where(
      and(
        eq(probeLocations.organizationId, machine.organizationId),
        eq(probeLocations.id, machine.locationId),
      ),
    )
    .limit(1)
    .for('update', { of: probeLocations });
  if (!location || location.status !== 'ACTIVE') throw new Error('PROBE_AUTH');
}

async function lockAssignment(
  tx: Transaction,
  machine: ProbeMachineIdentity,
  assignmentId: string,
) {
  const [assignment] = await tx
    .select({
      ...getTableColumns(checkExecutionAssignments),
      unexpired: sql<boolean>`${checkExecutionAssignments.claimExpiresAt} > clock_timestamp()`,
    })
    .from(checkExecutionAssignments)
    .where(
      and(
        eq(checkExecutionAssignments.organizationId, machine.organizationId),
        eq(checkExecutionAssignments.id, assignmentId),
        eq(checkExecutionAssignments.probeLocationId, machine.locationId),
      ),
    )
    .limit(1)
    .for('update', { of: checkExecutionAssignments });
  return assignment;
}

async function lockPendingRoundForAttempt(
  tx: Transaction,
  machine: ProbeMachineIdentity,
  attemptId: string,
): Promise<boolean> {
  const [round] = await tx
    .select({
      acceptingWork: sql<boolean>`${checkRounds.status} = 'PENDING' and ${checkRounds.finalizationDeadlineAt} > clock_timestamp()`,
    })
    .from(checkRounds)
    .innerJoin(
      checkExecutionAssignments,
      and(
        eq(checkExecutionAssignments.organizationId, checkRounds.organizationId),
        eq(checkExecutionAssignments.roundId, checkRounds.id),
      ),
    )
    .innerJoin(
      probeExecutionAttempts,
      and(
        eq(probeExecutionAttempts.organizationId, checkExecutionAssignments.organizationId),
        eq(probeExecutionAttempts.assignmentId, checkExecutionAssignments.id),
      ),
    )
    .where(
      and(
        eq(probeExecutionAttempts.organizationId, machine.organizationId),
        eq(probeExecutionAttempts.id, attemptId),
        eq(probeExecutionAttempts.agentId, machine.agentId),
        eq(probeExecutionAttempts.locationId, machine.locationId),
      ),
    )
    .limit(1)
    .for('update', { of: checkRounds });
  return round?.acceptingWork === true;
}

async function lockRoundForAssignment(
  tx: Transaction,
  machine: ProbeMachineIdentity,
  assignmentId: string,
): Promise<{ acceptingWork: boolean } | null> {
  const [round] = await tx
    .select({
      acceptingWork: sql<boolean>`${checkRounds.status} = 'PENDING' and ${checkRounds.finalizationDeadlineAt} > clock_timestamp()`,
    })
    .from(checkRounds)
    .innerJoin(
      checkExecutionAssignments,
      and(
        eq(checkExecutionAssignments.organizationId, checkRounds.organizationId),
        eq(checkExecutionAssignments.roundId, checkRounds.id),
      ),
    )
    .where(
      and(
        eq(checkExecutionAssignments.organizationId, machine.organizationId),
        eq(checkExecutionAssignments.id, assignmentId),
        eq(checkExecutionAssignments.probeLocationId, machine.locationId),
      ),
    )
    .limit(1)
    .for('update', { of: checkRounds });
  return round ?? null;
}

async function lockAttempt(
  tx: Transaction,
  machine: ProbeMachineIdentity,
  reference: ProbeResultSubmissionReferenceV1,
) {
  const [attempt] = await tx
    .select({
      ...getTableColumns(probeExecutionAttempts),
      unexpired: sql<boolean>`${probeExecutionAttempts.leaseExpiresAt} > clock_timestamp()`,
    })
    .from(probeExecutionAttempts)
    .where(
      and(
        eq(probeExecutionAttempts.organizationId, machine.organizationId),
        eq(probeExecutionAttempts.id, reference.attemptId),
        eq(probeExecutionAttempts.assignmentId, reference.assignmentId),
        eq(probeExecutionAttempts.agentId, machine.agentId),
        eq(probeExecutionAttempts.locationId, machine.locationId),
      ),
    )
    .limit(1)
    .for('update', { of: probeExecutionAttempts });
  return attempt;
}

function isAuthoritativeAttempt(
  attempt: Awaited<ReturnType<typeof lockAttempt>>,
  reference: ProbeResultSubmissionReferenceV1,
  claimToken: string,
  assignment: NonNullable<Awaited<ReturnType<typeof lockAssignment>>>,
): boolean {
  return Boolean(
    attempt &&
    attempt.status === 'LEASED' &&
    attempt.attemptNumber === reference.attemptNumber &&
    attempt.submittedEngineVersion === null &&
    attempt.claimTokenVerifier === verifier(claimToken) &&
    attempt.unexpired &&
    assignment.status === 'RUNNING' &&
    assignment.attemptCount === reference.attemptNumber &&
    assignment.requiredEngineVersion === reference.engineVersion &&
    assignment.unexpired,
  );
}

async function expireLeasedAttempt(tx: Transaction, organizationId: string, assignmentId: string) {
  await tx
    .update(probeExecutionAttempts)
    .set({ status: 'EXPIRED', terminalReason: 'LEASE_EXPIRED', updatedAt: sql`clock_timestamp()` })
    .where(
      and(
        eq(probeExecutionAttempts.organizationId, organizationId),
        eq(probeExecutionAttempts.assignmentId, assignmentId),
        eq(probeExecutionAttempts.status, 'LEASED'),
        lte(probeExecutionAttempts.leaseExpiresAt, sql`clock_timestamp()`),
      ),
    );
}

function verifier(secret: string): string {
  return createHash('sha256').update(secret).digest('base64url');
}

async function databaseClock(tx: Transaction): Promise<Date> {
  const result = await tx.execute<{ checkedAt: string }>(
    sql`select date_trunc('milliseconds', clock_timestamp()) as "checkedAt"`,
  );
  const checkedAt = result.rows[0]?.checkedAt;
  if (!checkedAt) throw new Error('Database clock query returned no value.');
  return new Date(checkedAt);
}

function sameResult(
  stored: typeof checkExecutionResults.$inferSelect,
  result: AuthoritativeCheckResult,
): boolean {
  return (
    stored.outcome === result.outcome &&
    stored.stage === result.stage &&
    stored.reason === result.reason &&
    stored.statusCode === result.statusCode &&
    stored.responseTimeMs === result.responseTimeMs &&
    stored.attemptDurationMs === result.attemptDurationMs &&
    stored.checkedAt.getTime() === result.checkedAt.getTime() &&
    isDeepStrictEqual(stored.redirects, result.redirects) &&
    isDeepStrictEqual(stored.assertionEvaluation, result.assertionEvaluation)
  );
}
