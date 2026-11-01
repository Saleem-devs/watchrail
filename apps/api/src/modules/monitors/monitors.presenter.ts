import type {
  CheckHistoryDetail,
  CheckHistoryListItem,
  AvailabilityHistory,
  CheckRoundRecord,
  CurrentCheck,
  CurrentIncidentState,
  IncidentDetail,
  IncidentHistoryItem,
  OrganizationIncidentHistoryItem,
  MonitorRecord,
  UptimeMetrics,
} from '@watchrail/db';
import {
  parseStoredRequestHeaders,
  parseStoredAssertionConfiguration,
  type HttpRedirectHop,
  type HttpStatusPolicy,
  type AssertionEvaluationV1,
  type HttpRequestBody,
  type TlsCertificateEvidenceV1,
  type TlsCertificatePolicy,
} from '@watchrail/domain';

export interface MonitorResponse {
  id: string;
  projectId: string;
  name: string;
  url: string;
  method: string;
  lifecycleState: string;
  timeoutMs: number;
  intervalSeconds: number;
  nextCheckAt: string | null;
  followRedirects: boolean;
  statusPolicy: HttpStatusPolicy;
  tlsPolicy: TlsCertificatePolicy;
  requestHeaders: Array<{
    name: string;
    sensitive: boolean;
    value: string | null;
    hasValue: true;
  }>;
  requestBody: HttpRequestBody;
  assertions: unknown;
  locations: string[];
  createdAt: string;
  updatedAt: string;
  currentCheck: {
    availability: CurrentCheck['availability'];
    responseTimeMs: number | null;
    checkedAt: string;
    roundId: string;
    trigger: CurrentCheck['trigger'];
    kind: CurrentCheck['kind'];
    location: string | null;
    aggregateOutcome: CurrentCheck['aggregateOutcome'];
    coverage: CurrentCheck['coverage'];
    reachability: CurrentCheck['reachability'];
  } | null;
  incidentState: ReturnType<typeof toIncidentStateResponse>;
  uptime: UptimeMetrics;
}

export interface CheckRoundResponse {
  id: string;
  monitorId: string;
  trigger: 'MANUAL' | 'SCHEDULED';
  status: string;
  assignmentStatus: string | null;
  location: string | null;
  createdAt: string;
  result:
    | {
        outcome: string;
        stage: string;
        reason: string;
        statusCode: number | null;
        responseTimeMs: number | null;
        attemptDurationMs: number;
        redirects: HttpRedirectHop[];
        assertionEvaluation: AssertionEvaluationV1;
        tlsCertificates?: TlsCertificateEvidenceV1[];
        checkedAt: string;
      }
    | {
        kind: 'MULTI_LOCATION';
        outcome: string;
        counts: unknown;
        coverage: unknown;
        reachability: unknown;
        finalizedAt: string;
        regions: Array<{
          location: string;
          phase: string;
          outcome: string | null;
          terminalReason: string | null;
          executions: Array<{
            id: string;
            role: string;
            agentId: string;
            observation: unknown;
            diagnosticSummary: unknown;
            acceptedAt: string;
          }>;
        }>;
      }
    | null;
}

export function toResponse(
  monitor: MonitorRecord,
  currentCheck: CurrentCheck | null = null,
  incidentState: CurrentIncidentState,
  uptime: UptimeMetrics,
): MonitorResponse {
  return {
    id: monitor.id,
    projectId: monitor.projectId,
    uptime,
    name: monitor.name,
    url: monitor.url,
    method: monitor.method,
    lifecycleState: monitor.lifecycleState,
    timeoutMs: monitor.timeoutMs,
    intervalSeconds: monitor.intervalSeconds,
    nextCheckAt: monitor.nextCheckAt?.toISOString() ?? null,
    followRedirects: monitor.followRedirects,
    statusPolicy: monitor.statusPolicy,
    tlsPolicy: monitor.tlsPolicy,
    requestHeaders: redactRequestHeaders(monitor.requestHeaders),
    requestBody: monitor.requestBody,
    assertions: redactAssertions(monitor.assertions),
    locations: monitor.locations,
    createdAt: monitor.createdAt.toISOString(),
    updatedAt: monitor.updatedAt.toISOString(),
    currentCheck: currentCheck
      ? { ...currentCheck, checkedAt: currentCheck.checkedAt.toISOString() }
      : null,
    incidentState: toIncidentStateResponse(incidentState),
  };
}

export function toIncidentStateResponse(state: CurrentIncidentState) {
  return {
    failureStreak: state.failureStreak
      ? { ...state.failureStreak, startedAt: state.failureStreak.startedAt.toISOString() }
      : null,
    currentIncident: state.currentIncident
      ? {
          ...state.currentIncident,
          startedAt: state.currentIncident.startedAt.toISOString(),
          openedAt: state.currentIncident.openedAt.toISOString(),
        }
      : null,
    ...(state.multiLocationIncident ? { multiLocationIncident: state.multiLocationIncident } : {}),
  };
}

export function toIncidentHistoryResponse(incident: IncidentHistoryItem) {
  return {
    ...incident,
    startedAt: incident.startedAt.toISOString(),
    openedAt: incident.openedAt.toISOString(),
    resolvedAt: incident.resolvedAt?.toISOString() ?? null,
  };
}

export function toOrganizationIncidentHistoryResponse(incident: OrganizationIncidentHistoryItem) {
  return {
    ...toIncidentHistoryResponse(incident),
    monitorId: incident.monitorId,
    monitorName: incident.monitorName,
    monitorUrl: incident.monitorUrl,
    severity: incident.severity,
  };
}

export function toIncidentDetailResponse(incident: IncidentDetail) {
  return {
    ...toIncidentHistoryResponse(incident),
    monitorId: incident.monitorId,
    startedByRoundId: incident.startedByRoundId,
    openedByRoundId: incident.openedByRoundId,
    resolvedByRoundId: incident.resolvedByRoundId,
    createdAt: incident.createdAt.toISOString(),
  };
}

function redactRequestHeaders(value: unknown): MonitorResponse['requestHeaders'] {
  return parseStoredRequestHeaders(value).map((header) => ({
    name: header.name,
    sensitive: header.sensitive,
    value: header.sensitive ? null : header.value,
    hasValue: true,
  }));
}

function redactAssertions(value: unknown): unknown {
  const configuration = parseStoredAssertionConfiguration(value);
  const redactTarget = (target: unknown) => {
    if (
      typeof target === 'object' &&
      target !== null &&
      'sensitive' in target &&
      target.sensitive === true
    ) {
      return { sensitive: true, hasValue: true };
    }
    return target;
  };
  return {
    contractVersion: 1,
    assertions: {
      headers: configuration.assertions.headers.map((assertion) =>
        'target' in assertion
          ? { ...assertion, target: redactTarget(assertion.target) }
          : assertion,
      ),
      textBody: configuration.assertions.textBody.map((assertion) => ({
        ...assertion,
        target: redactTarget(assertion.target),
      })),
      jsonBody: configuration.assertions.jsonBody.map((assertion) =>
        'target' in assertion
          ? { ...assertion, target: redactTarget(assertion.target) }
          : assertion,
      ),
    },
  };
}

export function toPendingRoundResponse(round: CheckRoundRecord): CheckRoundResponse {
  return {
    id: round.id,
    monitorId: round.monitorId,
    trigger: round.trigger,
    status: round.status,
    assignmentStatus: 'PENDING',
    location: null,
    createdAt: round.createdAt.toISOString(),
    result: null,
  };
}

export function toCheckRoundResponse(round: CheckHistoryDetail): CheckRoundResponse {
  return {
    id: round.id,
    monitorId: round.monitorId,
    trigger: round.trigger,
    status: round.status,
    assignmentStatus: round.assignmentStatus,
    location: round.location,
    createdAt: round.createdAt.toISOString(),
    result: round.result
      ? round.result.kind === 'SINGLE_LOCATION'
        ? toSingleLocationDetailResponse(round.result)
        : {
            ...round.result,
            finalizedAt: round.result.finalizedAt.toISOString(),
            regions: round.result.regions.map((region) => ({
              ...region,
              executions: region.executions.map((execution) => ({
                ...execution,
                acceptedAt: execution.acceptedAt.toISOString(),
              })),
            })),
          }
      : null,
  };
}

export function toHistoryListItem(round: CheckHistoryListItem) {
  return {
    ...round,
    createdAt: round.createdAt.toISOString(),
    result: round.result
      ? round.result.kind === 'SINGLE_LOCATION'
        ? toSingleLocationListResponse(round.result)
        : { ...round.result, finalizedAt: round.result.finalizedAt.toISOString() }
      : null,
  };
}

export function toAvailabilityHistoryResponse(history: AvailabilityHistory) {
  return {
    range: {
      ...history.range,
      start: history.range.start.toISOString(),
      end: history.range.end.toISOString(),
    },
    buckets: history.buckets.map((bucket) => ({
      ...bucket,
      start: bucket.start.toISOString(),
      end: bucket.end.toISOString(),
    })),
  };
}

function toSingleLocationDetailResponse(
  result: Extract<NonNullable<CheckHistoryDetail['result']>, { kind: 'SINGLE_LOCATION' }>,
) {
  return {
    outcome: result.outcome,
    stage: result.stage,
    reason: result.reason,
    statusCode: result.statusCode,
    responseTimeMs: result.responseTimeMs,
    attemptDurationMs: result.attemptDurationMs,
    redirects: result.redirects,
    assertionEvaluation: result.assertionEvaluation,
    ...(result.tlsCertificates.length === 0 ? {} : { tlsCertificates: result.tlsCertificates }),
    checkedAt: result.checkedAt.toISOString(),
  };
}

function toSingleLocationListResponse(
  result: Extract<NonNullable<CheckHistoryListItem['result']>, { kind: 'SINGLE_LOCATION' }>,
) {
  return {
    outcome: result.outcome,
    stage: result.stage,
    reason: result.reason,
    statusCode: result.statusCode,
    responseTimeMs: result.responseTimeMs,
    attemptDurationMs: result.attemptDurationMs,
    assertionOutcome: result.assertionOutcome,
    checkedAt: result.checkedAt.toISOString(),
  };
}
