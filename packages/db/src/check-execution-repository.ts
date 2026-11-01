import { and, eq, sql } from 'drizzle-orm';
import {
  classifyIncidentObservation,
  INCIDENT_FAILURE_THRESHOLD,
  parseHttpRedirectHops,
  parseStoredAssertionEvaluation,
  parseTlsCertificateEvidenceList,
  type AssertionEvaluationV1,
  type HttpMethod,
  type HttpRedirectHop,
  type HttpStatusPolicy,
  type HttpRequestBody,
  type ResponseAssertionConfigurationV1,
  type StoredRequestHeader,
  type TlsCertificateEvidenceV1,
  type TlsCertificatePolicy,
  type DnsRecordType,
} from '@watchrail/domain';
import type { WatchrailDatabase } from './client.js';
import { applyAvailabilityObservation } from './availability-repository.js';
import {
  stageIncidentNotification,
  type IncidentTransition,
} from './notification-event-repository.js';
import {
  checkExecutionAssignments,
  checkExecutionResults,
  checkRoundLocations,
  checkRounds,
  incidents,
  monitorIncidentState,
  monitorConfigurationVersions,
  type CheckExecutionResultRecord,
} from './schema.js';

interface ClaimedCheckExecutionBase {
  assignmentId: string;
  claimToken: string;
  attemptNumber: number;
  timeoutMs: number;
  organizationId: string;
  monitorId: string;
}

export interface ClaimedHttpCheckExecution extends ClaimedCheckExecutionBase {
  type: 'HTTP';
  url: string;
  method: HttpMethod;
  followRedirects: boolean;
  statusPolicy: HttpStatusPolicy;
  requestHeaders: readonly StoredRequestHeader[];
  requestBody: HttpRequestBody;
  assertions: ResponseAssertionConfigurationV1;
  tlsPolicy?: TlsCertificatePolicy;
}

export interface ClaimedTcpCheckExecution extends ClaimedCheckExecutionBase {
  type: 'TCP';
  host: string;
  port: number;
  assertions?: never;
  requestHeaders?: never;
  requestBody?: never;
  statusPolicy?: never;
  tlsPolicy?: never;
  url?: never;
  method?: never;
  followRedirects?: never;
}

export interface ClaimedDnsCheckExecution extends ClaimedCheckExecutionBase {
  type: 'DNS';
  name: string;
  recordType: DnsRecordType;
  expectedValues: string[];
}

export type ClaimedCheckExecution =
  ClaimedHttpCheckExecution | ClaimedTcpCheckExecution | ClaimedDnsCheckExecution;

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
  redirects: readonly HttpRedirectHop[];
  assertionEvaluation: AssertionEvaluationV1;
  tlsCertificates?: readonly TlsCertificateEvidenceV1[];
  dnsAnswers?: readonly string[];
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
          roundStatus: checkRounds.status,
          status: checkExecutionAssignments.status,
          claimAvailable: sql<boolean>`
            ${checkExecutionAssignments.status} <> 'RUNNING'
            or ${checkExecutionAssignments.claimExpiresAt} <= now()
          `,
          attemptCount: checkExecutionAssignments.attemptCount,
          type: monitorConfigurationVersions.type,
          tcpHost: monitorConfigurationVersions.tcpHost,
          tcpPort: monitorConfigurationVersions.tcpPort,
          dnsName: monitorConfigurationVersions.dnsName,
          dnsRecordType: monitorConfigurationVersions.dnsRecordType,
          dnsExpectedValues: monitorConfigurationVersions.dnsExpectedValues,
          url: monitorConfigurationVersions.url,
          method: monitorConfigurationVersions.method,
          timeoutMs: monitorConfigurationVersions.timeoutMs,
          followRedirects: monitorConfigurationVersions.followRedirects,
          statusPolicy: monitorConfigurationVersions.statusPolicy,
          organizationId: monitorConfigurationVersions.organizationId,
          monitorId: monitorConfigurationVersions.monitorId,
          requestHeaders: monitorConfigurationVersions.requestHeaders,
          requestBody: monitorConfigurationVersions.requestBody,
          assertions: monitorConfigurationVersions.assertions,
          tlsPolicy: monitorConfigurationVersions.tlsPolicy,
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
      if (candidate.roundStatus === 'COMPLETED') return { state: 'COMPLETED' };
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
        execution:
          candidate.type === 'TCP'
            ? createClaimedTcpExecution(candidate, claimed.claimToken, claimed.attemptNumber)
            : candidate.type === 'DNS'
              ? createClaimedDnsExecution(candidate, claimed.claimToken, claimed.attemptNumber)
              : {
                  type: 'HTTP',
                  assignmentId: candidate.assignmentId,
                  claimToken: claimed.claimToken,
                  attemptNumber: claimed.attemptNumber,
                  url: candidate.url,
                  method: candidate.method,
                  timeoutMs: candidate.timeoutMs,
                  followRedirects: candidate.followRedirects,
                  statusPolicy: candidate.statusPolicy,
                  organizationId: candidate.organizationId,
                  monitorId: candidate.monitorId,
                  requestHeaders: candidate.requestHeaders,
                  requestBody: candidate.requestBody,
                  assertions: candidate.assertions,
                  tlsPolicy: candidate.tlsPolicy,
                },
      };
    });
  }

  async complete(
    assignmentId: string,
    claimToken: string,
    result: AuthoritativeCheckResult,
  ): Promise<boolean> {
    const redirects = parseHttpRedirectHops(result.redirects);
    const assertionEvaluation = parseStoredAssertionEvaluation(result.assertionEvaluation);
    const tlsCertificates = parseTlsCertificateEvidenceList(result.tlsCertificates ?? []);

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

      await finalizeCheckExecution(tx, {
        assignmentId,
        organizationId: completed.organizationId,
        roundId: completed.roundId,
        result: { ...result, redirects, assertionEvaluation, tlsCertificates },
      });

      return true;
    });
  }
}

function createClaimedDnsExecution(
  candidate: {
    assignmentId: string;
    dnsName: string | null;
    dnsRecordType: DnsRecordType | null;
    dnsExpectedValues: string[];
    timeoutMs: number;
    organizationId: string;
    monitorId: string;
  },
  claimToken: string,
  attemptNumber: number,
): ClaimedDnsCheckExecution {
  if (candidate.dnsName === null || candidate.dnsRecordType === null) {
    throw new Error('DNS execution configuration is incomplete.');
  }
  return {
    type: 'DNS',
    assignmentId: candidate.assignmentId,
    claimToken,
    attemptNumber,
    name: candidate.dnsName,
    recordType: candidate.dnsRecordType,
    expectedValues: candidate.dnsExpectedValues,
    timeoutMs: candidate.timeoutMs,
    organizationId: candidate.organizationId,
    monitorId: candidate.monitorId,
  };
}

function createClaimedTcpExecution(
  candidate: {
    assignmentId: string;
    tcpHost: string | null;
    tcpPort: number | null;
    timeoutMs: number;
    organizationId: string;
    monitorId: string;
  },
  claimToken: string,
  attemptNumber: number,
): ClaimedTcpCheckExecution {
  if (candidate.tcpHost === null || candidate.tcpPort === null) {
    throw new Error('TCP execution configuration is incomplete.');
  }
  return {
    type: 'TCP',
    assignmentId: candidate.assignmentId,
    claimToken,
    attemptNumber,
    host: candidate.tcpHost,
    port: candidate.tcpPort,
    timeoutMs: candidate.timeoutMs,
    organizationId: candidate.organizationId,
    monitorId: candidate.monitorId,
  };
}

export async function finalizeCheckExecution(
  tx: Parameters<Parameters<WatchrailDatabase['transaction']>[0]>[0],
  input: {
    assignmentId: string;
    organizationId: string;
    roundId: string;
    result: AuthoritativeCheckResult;
  },
): Promise<void> {
  const [locationSummary] = await tx
    .select({ locationCount: sql<number>`count(*)::integer` })
    .from(checkRoundLocations)
    .where(eq(checkRoundLocations.roundId, input.roundId));
  if ((locationSummary?.locationCount ?? 0) !== 1) {
    throw new Error('Legacy execution finalization requires exactly one round location.');
  }
  const redirects = parseHttpRedirectHops(input.result.redirects);
  const assertionEvaluation = parseStoredAssertionEvaluation(input.result.assertionEvaluation);
  const tlsCertificates = parseTlsCertificateEvidenceList(input.result.tlsCertificates ?? []);

  await tx.insert(checkExecutionResults).values({
    organizationId: input.organizationId,
    roundId: input.roundId,
    assignmentId: input.assignmentId,
    outcome: input.result.outcome,
    stage: input.result.stage,
    reason: input.result.reason,
    statusCode: input.result.statusCode,
    responseTimeMs: input.result.responseTimeMs,
    attemptDurationMs: input.result.attemptDurationMs,
    redirects,
    assertionEvaluation,
    tlsCertificates,
    dnsAnswers: [...(input.result.dnsAnswers ?? [])],
    checkedAt: input.result.checkedAt,
  });

  await tx
    .update(checkRounds)
    .set({ status: 'COMPLETED' })
    .where(eq(checkRounds.id, input.roundId));

  const [round] = await tx
    .select({
      id: checkRounds.id,
      organizationId: checkRounds.organizationId,
      monitorId: checkRounds.monitorId,
      trigger: checkRounds.trigger,
      createdAt: checkRounds.createdAt,
    })
    .from(checkRounds)
    .where(eq(checkRounds.id, input.roundId))
    .limit(1);

  if (!round) throw new Error('Completed check round is missing.');
  if (round.trigger === 'SCHEDULED') {
    const incidentTransition = await applyIncidentObservation(tx, round, input.result);
    await applyAvailabilityObservation(tx, round, {
      trigger: round.trigger,
      outcome: input.result.outcome,
      reason: input.result.reason,
      assertionOutcome: assertionEvaluation.outcome,
    });
    await stageIncidentNotification(tx, incidentTransition);
  }
}

async function applyIncidentObservation(
  tx: Parameters<Parameters<WatchrailDatabase['transaction']>[0]>[0],
  round: {
    id: string;
    organizationId: string;
    monitorId: string;
    createdAt: Date;
  },
  result: AuthoritativeCheckResult,
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
  if (round.createdAt < state.trackingStartedAt || isStaleRound(round, state))
    return { type: 'NONE' };

  const observation = classifyIncidentObservation({
    outcome: result.outcome,
    reason: result.reason,
    assertionOutcome: result.assertionEvaluation.outcome,
  });
  const processed = {
    lastProcessedRoundCreatedAt: round.createdAt,
    lastProcessedRoundId: round.id,
    updatedAt: sql`clock_timestamp()`,
  };

  if (observation === 'INDETERMINATE') {
    await tx
      .update(monitorIncidentState)
      .set(processed)
      .where(eq(monitorIncidentState.monitorId, round.monitorId));
    return { type: 'NONE' };
  }

  if (observation === 'HEALTHY') {
    await tx
      .update(monitorIncidentState)
      .set({
        ...processed,
        consecutiveFailures: 0,
        failureStreakStartedAt: null,
        failureStreakStartedRoundId: null,
      })
      .where(eq(monitorIncidentState.monitorId, round.monitorId));
    const [resolved] = await tx
      .update(incidents)
      .set({
        status: 'RESOLVED',
        resolvedAt: sql`greatest(${incidents.openedAt}, ${result.checkedAt})`,
        resolvedByRoundId: round.id,
      })
      .where(
        and(
          eq(incidents.organizationId, round.organizationId),
          eq(incidents.monitorId, round.monitorId),
          eq(incidents.status, 'OPEN'),
        ),
      )
      .returning({
        id: incidents.id,
        status: incidents.status,
        startedAt: incidents.startedAt,
        openedAt: incidents.openedAt,
        resolvedAt: incidents.resolvedAt,
      });
    return resolved
      ? {
          type: 'RESOLVED',
          incident: resolved,
          organizationId: round.organizationId,
          monitorId: round.monitorId,
          triggeringRoundId: round.id,
        }
      : { type: 'NONE' };
  }

  const consecutiveFailures = state.consecutiveFailures + 1;
  const failureStreakStartedAt = state.failureStreakStartedAt ?? result.checkedAt;
  const failureStreakStartedRoundId = state.failureStreakStartedRoundId ?? round.id;
  await tx
    .update(monitorIncidentState)
    .set({
      ...processed,
      consecutiveFailures,
      failureStreakStartedAt,
      failureStreakStartedRoundId,
    })
    .where(eq(monitorIncidentState.monitorId, round.monitorId));

  if (consecutiveFailures === INCIDENT_FAILURE_THRESHOLD) {
    const openedAt = laterDate(result.checkedAt, failureStreakStartedAt);
    const [opened] = await tx
      .insert(incidents)
      .values({
        organizationId: round.organizationId,
        monitorId: round.monitorId,
        status: 'OPEN',
        startedAt: failureStreakStartedAt,
        openedAt,
        startedByRoundId: failureStreakStartedRoundId,
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
    return {
      type: 'OPENED',
      incident: opened,
      organizationId: round.organizationId,
      monitorId: round.monitorId,
      triggeringRoundId: round.id,
    };
  }
  return { type: 'NONE' };
}

function laterDate(left: Date, right: Date): Date {
  return left.getTime() >= right.getTime() ? left : right;
}

function isStaleRound(
  round: { id: string; createdAt: Date },
  state: {
    lastProcessedRoundCreatedAt: Date | null;
    lastProcessedRoundId: string | null;
  },
): boolean {
  if (!state.lastProcessedRoundCreatedAt || !state.lastProcessedRoundId) return false;
  const timeDifference = round.createdAt.getTime() - state.lastProcessedRoundCreatedAt.getTime();
  return timeDifference < 0 || (timeDifference === 0 && round.id <= state.lastProcessedRoundId);
}

function assertPositiveMilliseconds(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive safe integer.`);
  }
}
