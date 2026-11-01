import type { RequestBodyValue } from './request-body-field';
import type { RedactedResponseAssertionConfiguration } from './response-assertions';

export type TlsCertificatePolicy =
  { type: 'DISABLED' } | { type: 'MINIMUM_VALIDITY'; days: 1 | 2 | 3 | 7 | 14 | 30 | 60 };

export interface TlsCertificateEvidence {
  contractVersion: 1;
  origin: string;
  hostname: string;
  validFrom: string;
  validTo: string;
  fingerprint256: string;
  subject: string;
  issuer: string;
  protocol: string;
  cipher: string;
}

/* Monitor feature API contracts. */
export interface Monitor {
  id: string;
  projectId?: string;
  name: string;
  url: string;
  method: string;
  lifecycleState: 'ENABLED' | 'PAUSED';
  timeoutMs: number;
  followRedirects: boolean;
  statusPolicy: { type: 'ANY_2XX' } | { type: 'EXACT'; statusCodes: number[] };
  tlsPolicy?: TlsCertificatePolicy;
  requestHeaders?: Array<{
    name: string;
    sensitive: boolean;
    value: string | null;
    hasValue: true;
  }>;
  requestBody?: RequestBodyValue;
  assertions?: RedactedResponseAssertionConfiguration;
  locations: string[];
  createdAt: string;
  currentCheck: CurrentCheck | null;
  incidentState: IncidentState;
  uptime: { uptimePercent: number | null; coveragePercent: number | null };
}

export interface ListPage {
  number: number;
  limit: number;
  total: number;
  totalPages: number;
}

export interface ProbeLocation {
  id: string;
  name: string;
  status: 'ACTIVE' | 'DISABLED';
  health: 'NOT_CONNECTED' | 'ONLINE' | 'STALE' | 'OFFLINE' | 'DISABLED';
  activeAgentCount: number;
}

export interface IncidentState {
  failureStreak: {
    count: number;
    threshold: number;
    startedAt: string;
    startedByRoundId: string;
  } | null;
  currentIncident: {
    id: string;
    status: 'OPEN';
    startedAt: string;
    openedAt: string;
    startedByRoundId: string;
    openedByRoundId: string;
  } | null;
  multiLocationIncident?: {
    severity: 'DEGRADED' | 'DOWN';
    healthyRecoveryStreak: 0 | 1;
    healthyRecoveryThreshold: 2;
  } | null;
}

export interface CurrentCheck {
  kind: 'SINGLE_LOCATION' | 'MULTI_LOCATION';
  availability: 'AVAILABLE' | 'UNAVAILABLE' | 'UNKNOWN';
  responseTimeMs: number | null;
  checkedAt: string;
  roundId: string;
  trigger: 'MANUAL' | 'SCHEDULED';
  aggregateOutcome: 'UP' | 'DEGRADED' | 'DOWN' | 'UNKNOWN' | null;
  coverage: { numerator: number; denominator: number } | null;
  reachability: { numerator: number; denominator: number } | null;
}

export interface FieldErrors {
  name?: string[];
  url?: string[];
  statusPolicy?: string[];
  method?: string[];
  timeoutMs?: string[];
  followRedirects?: string[];
  lifecycleState?: string[];
  locations?: string[];
  requestHeaders?: string[];
  requestBody?: string[];
  assertions?: string[];
  tlsPolicy?: string[];
}

export interface AssertionDiagnostic {
  index: number;
  source: 'HEADER' | 'TEXT_BODY' | 'JSON_BODY';
  subject: string | null;
  operator: 'exists' | 'does_not_exist' | 'equals' | 'not_equals' | 'contains' | 'not_contains';
  outcome: 'PASS' | 'FAIL' | 'NOT_EVALUATED';
  reason:
    | 'MATCHED'
    | 'HEADER_MISMATCH'
    | 'TEXT_BODY_MISMATCH'
    | 'JSON_BODY_MISMATCH'
    | 'INVALID_JSON'
    | 'DUPLICATE_JSON_KEY'
    | 'JSON_TYPE_UNSUPPORTED'
    | 'UNSUPPORTED_CONTENT_ENCODING'
    | 'UNSUPPORTED_CHARSET'
    | 'BODY_TOO_LARGE'
    | 'BODY_READ_FAILED'
    | 'RESPONSE_UNAVAILABLE';
}

export interface AssertionEvaluation {
  contractVersion: 1;
  outcome: 'PASS' | 'FAIL' | 'NOT_EVALUATED';
  diagnostics: AssertionDiagnostic[];
}

export interface ApiError {
  message?: string;
  fields?: FieldErrors;
}

export interface ConfigurationTestResult {
  result: {
    outcome: 'PASS' | 'FAIL' | 'UNKNOWN';
    stage: 'DNS' | 'CONNECT' | 'TLS' | 'HTTP' | 'PROBE';
    reason: string;
    statusCode: number | null;
    responseTimeMs: number | null;
    attemptDurationMs: number;
    redirects: ManualRoundResultRedirect[];
    assertionEvaluation: AssertionEvaluation;
    tlsCertificates?: TlsCertificateEvidence[];
    checkedAt: string;
  };
  signals: {
    transport: 'PASS' | 'FAIL' | 'UNKNOWN';
    statusPolicy: 'PASS' | 'FAIL' | 'NOT_EVALUATED';
    assertions: 'PASS' | 'FAIL' | 'NOT_EVALUATED';
    tlsCertificate?: 'PASS' | 'FAIL' | 'NOT_EVALUATED' | 'DISABLED';
  };
  response: {
    headers: Array<{ name: string; values: string[]; redacted: boolean }>;
    withheldHeaderCount: number;
    body:
      | { state: 'PREVIEW'; contentType: string; text: string; truncated: boolean }
      | { state: 'UNAVAILABLE'; reason: string };
  };
}

export interface ManualRoundResultRedirect {
  sequence: number;
  statusCode: 301 | 302 | 303 | 307 | 308;
  source: { targetId: number; origin: string };
  destination: { targetId: number; origin: string } | null;
  responseTimeMs: number;
  headers: 'PRESERVED' | 'STRIPPED' | 'NOT_SENT';
}

export interface ManualRound {
  id: string;
  monitorId: string;
  trigger: 'MANUAL' | 'SCHEDULED';
  status: 'PENDING' | 'COMPLETED';
  assignmentStatus: 'PENDING' | 'RUNNING' | 'COMPLETED' | null;
  createdAt: string;
  result:
    | {
        kind?: 'SINGLE_LOCATION';
        outcome: 'PASS' | 'FAIL' | 'UNKNOWN';
        stage: 'DNS' | 'CONNECT' | 'TLS' | 'HTTP' | 'PROBE';
        reason: string;
        statusCode: number | null;
        responseTimeMs: number | null;
        attemptDurationMs: number;
        redirects: ManualRoundResultRedirect[];
        assertionOutcome?: AssertionEvaluation['outcome'];
        assertionEvaluation?: AssertionEvaluation;
        tlsCertificates?: TlsCertificateEvidence[];
        checkedAt: string;
      }
    | {
        kind: 'MULTI_LOCATION';
        outcome: 'UP' | 'DEGRADED' | 'DOWN' | 'UNKNOWN';
        counts: {
          selected: number;
          pass: number;
          confirmedFail: number;
          unknown: number;
          conclusive: number;
        };
        coverage: { numerator: number; denominator: number };
        reachability: { numerator: number; denominator: number } | null;
        finalizedAt: string;
        regions?: Array<{
          location: string;
          phase: string;
          outcome: 'PASS' | 'CONFIRMED_FAIL' | 'UNKNOWN' | null;
          terminalReason: string | null;
          executions: Array<{
            id: string;
            role: 'PRIMARY' | 'CONFIRMATION';
            diagnosticSummary: {
              stage: string;
              reason: string;
              statusCode: number | null;
              responseTimeMs: number | null;
              attemptDurationMs: number;
              checkedAt: string;
              assertionEvaluation?: AssertionEvaluation;
              tlsCertificates?: TlsCertificateEvidence[];
            } | null;
          }>;
        }>;
      }
    | null;
}

export interface HistoryPage {
  items: ManualRound[];
  nextCursor: string | null;
}

export type AvailabilityHistoryRange = '24h' | '7d' | '30d' | '90d';
export type AvailabilityHistoryStatus = 'UP' | 'DOWN' | 'DEGRADED' | 'UNKNOWN' | 'NO_DATA';

export interface AvailabilityHistory {
  range: {
    key: AvailabilityHistoryRange;
    start: string;
    end: string;
    bucketSeconds: number;
  };
  buckets: Array<{
    start: string;
    end: string;
    status: AvailabilityHistoryStatus;
    checks: number;
    up: number;
    down: number;
    degraded: number;
    unknown: number;
  }>;
}

export interface IncidentHistoryPage {
  items: Array<{
    id: string;
    status: 'OPEN' | 'RESOLVED';
    startedAt: string;
    openedAt: string;
    resolvedAt: string | null;
  }>;
  nextCursor: string | null;
}

export interface ResponseTimeOverview {
  range: { start: string; end: string; timezone: 'UTC' };
  series: Array<{
    monitorId: string;
    monitorName: string;
    points: Array<{
      date: string;
      averageResponseTimeMs: number;
      sampleCount: number;
    }>;
  }>;
}
