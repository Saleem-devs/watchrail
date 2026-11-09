import type { RequestBodyValue } from './request-body-field';
import type {
  RedactedResponseAssertionConfiguration,
  SerializedResponseAssertions,
} from './response-assertions';

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
  type:
    'HTTP' | 'TCP' | 'DNS' | 'ICMP' | 'KEYWORD' | 'API_WORKFLOW' | 'HEARTBEAT' | 'DOMAIN_EXPIRY';
  name: string;
  url: string;
  configuration:
    | { type: 'HTTP'; url: string }
    | { type: 'TCP'; host: string; port: number }
    | { type: 'ICMP'; host: string }
    | { type: 'KEYWORD'; url: string; keyword: string; match: 'CONTAINS' | 'NOT_CONTAINS' }
    | {
        type: 'DNS';
        name: string;
        recordType: 'A' | 'AAAA' | 'CNAME' | 'MX' | 'TXT' | 'NS';
        expectedValues: string[];
      }
    | { type: 'API_WORKFLOW'; workflow: ApiWorkflowConfiguration }
    | { type: 'HEARTBEAT'; heartbeat: HeartbeatMonitorSettings }
    | { type: 'DOMAIN_EXPIRY'; domainName: string; warningDays: number };
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
    secretReference?: { contractVersion: 1; secretId: string };
  }>;
  requestBody?: RequestBodyValue;
  assertions?: RedactedResponseAssertionConfiguration;
  locations: string[];
  createdAt: string;
  currentCheck: CurrentCheck | null;
  incidentState: IncidentState;
  uptime: { uptimePercent: number | null; coveragePercent: number | null };
  heartbeatIngestionPath?: string;
}

export type HeartbeatSchedule =
  | { type: 'INTERVAL'; intervalSeconds: number; graceSeconds: number }
  | { type: 'CRON'; expression: string; timezone: string; graceSeconds: number };

export interface HeartbeatMonitorSettings {
  schedule: HeartbeatSchedule;
  maximumRuntimeSeconds: number | null;
}

export interface HeartbeatResultEvidence {
  contractVersion: 1;
  signal: 'PING' | 'START' | 'COMPLETE' | 'FAIL' | 'MISSED';
  runId: string | null;
  message: string | null;
  metadata: Record<string, string | number | boolean | null>;
  expectedAt: string | null;
  receivedAt: string | null;
  runtimeMs: number | null;
}

export interface DomainExpiryResultEvidence {
  contractVersion: 1;
  domainName: string;
  expirationDate: string | null;
  daysRemaining: number | null;
  warningDays: number;
}

export interface ListPage {
  number: number;
  limit: number;
  total: number;
  totalPages: number;
}

export interface MonitorListSummary {
  total: number;
  operational: number;
  attention: number;
  paused: number;
  pending: number;
  openIncidents: number;
  averageUptimePercent: number | null;
  averageCoveragePercent: number | null;
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
  type?: string[];
  name?: string[];
  url?: string[];
  host?: string[];
  port?: string[];
  tcpSettings?: string[];
  icmpSettings?: string[];
  keyword?: string[];
  keywordMatch?: string[];
  keywordSettings?: string[];
  dnsName?: string[];
  dnsRecordType?: string[];
  dnsExpectedValues?: string[];
  dnsSettings?: string[];
  domainName?: string[];
  domainWarningDays?: string[];
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
  workflow?: string[];
  heartbeat?: string[];
  schedule?: string[];
  expression?: string[];
  timezone?: string[];
  intervalSeconds?: string[];
  graceSeconds?: string[];
  maximumRuntimeSeconds?: string[];
}

export type ApiWorkflowRequestBody =
  | { type: 'NONE' }
  | { type: 'JSON'; value: string }
  | { type: 'FORM_URLENCODED'; fields: Array<{ name: string; value: string }> }
  | { type: 'RAW'; contentType: string; value: string }
  | {
      type: 'JSON' | 'FORM_URLENCODED' | 'RAW';
      sensitive: true;
      hasValue: true;
      secretReference?: { contractVersion: 1; secretId: string };
      contentType?: string;
    }
  | {
      type: 'JSON' | 'FORM_URLENCODED' | 'RAW';
      sensitive: true;
      retain: true;
    }
  | {
      type: 'JSON' | 'FORM_URLENCODED' | 'RAW';
      sensitive: true;
      secretReference: { contractVersion: 1; secretId: string };
      contentType?: string;
    };

export interface ApiWorkflowStepConfiguration {
  id: string;
  name: string;
  url: string;
  method: string;
  timeoutMs: number;
  followRedirects: boolean;
  statusPolicy: { type: 'ANY_2XX' } | { type: 'EXACT'; statusCodes: number[] };
  tlsPolicy: TlsCertificatePolicy;
  requestHeaders: Array<
    | {
        name: string;
        sensitive: boolean;
        value: string | null;
        hasValue: true;
        secretReference?: { contractVersion: 1; secretId: string };
      }
    | { name: string; sensitive: boolean; value: string }
    | { name: string; sensitive: true; retain: true }
    | {
        name: string;
        sensitive: true;
        secretReference: { contractVersion: 1; secretId: string };
      }
  >;
  requestBody: ApiWorkflowRequestBody;
  assertions: RedactedResponseAssertionConfiguration | SerializedResponseAssertions;
  extractions: Array<{ variable: string; selector: string; sensitive: boolean }>;
}

export interface ApiWorkflowConfiguration {
  contractVersion: 1;
  steps: ApiWorkflowStepConfiguration[];
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
        stage: 'DNS' | 'CONNECT' | 'TLS' | 'HTTP' | 'PROBE' | 'WORKFLOW' | 'HEARTBEAT' | 'DOMAIN';
        reason: string;
        statusCode: number | null;
        responseTimeMs: number | null;
        attemptDurationMs: number;
        redirects: ManualRoundResultRedirect[];
        assertionOutcome?: AssertionEvaluation['outcome'];
        assertionEvaluation?: AssertionEvaluation;
        tlsCertificates?: TlsCertificateEvidence[];
        dnsAnswers?: string[];
        workflowResult?: ApiWorkflowResult;
        heartbeatResult?: HeartbeatResultEvidence;
        domainExpiryResult?: DomainExpiryResultEvidence;
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
              dnsAnswers?: string[];
              workflowResult?: ApiWorkflowResult;
            } | null;
          }>;
        }>;
      }
    | null;
}

export interface ApiWorkflowResult {
  outcome: 'PASS' | 'FAIL' | 'UNKNOWN';
  stage: 'WORKFLOW';
  reason:
    | 'WORKFLOW_COMPLETED'
    | 'STEP_FAILED'
    | 'EXTRACTION_FAILED'
    | 'STEP_INDETERMINATE'
    | 'EXTRACTION_INDETERMINATE'
    | 'VARIABLE_UNAVAILABLE'
    | 'INTERNAL_ERROR';
  failedStepId: string | null;
  checkedAt: string;
  attemptDurationMs: number;
  steps: Array<
    | {
        id: string;
        name: string;
        position: number;
        status: 'SKIPPED';
        reason:
          | 'VARIABLE_UNAVAILABLE'
          | 'EXECUTION_ERROR'
          | 'PREVIOUS_STEP_FAILED'
          | 'PREVIOUS_STEP_INDETERMINATE';
      }
    | {
        id: string;
        name: string;
        position: number;
        status: 'EXECUTED';
        result: {
          outcome: 'PASS' | 'FAIL' | 'UNKNOWN';
          stage: 'DNS' | 'CONNECT' | 'TLS' | 'HTTP' | 'PROBE';
          reason: string;
          statusCode: number | null;
          responseTimeMs: number | null;
          attemptDurationMs: number;
          redirectCount: number;
          tlsCertificateCount: number;
          assertionEvaluation: AssertionEvaluation;
          checkedAt: string;
        };
        extractions: Array<{
          variable: string;
          selector: string;
          sensitive: boolean;
          outcome: 'CAPTURED' | 'FAILED' | 'NOT_EVALUATED';
          reason:
            | 'CAPTURED'
            | 'BODY_UNAVAILABLE'
            | 'INVALID_JSON'
            | 'VALUE_MISSING'
            | 'NON_SCALAR_VALUE'
            | 'VALUE_TOO_LARGE';
        }>;
      }
  >;
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

export interface DnsLocationEvidence {
  location: string;
  answers: string[];
}

export interface DnsRecordHistoryPage {
  current: {
    dnsName: string;
    recordType: 'A' | 'AAAA' | 'CNAME' | 'MX' | 'TXT' | 'NS';
    answers: string[];
    locationEvidence: DnsLocationEvidence[];
    observedAt: string;
    configurationVersionId: string;
  } | null;
  candidate: {
    answers: string[];
    locationEvidence: DnsLocationEvidence[];
    firstObservedAt: string;
  } | null;
  items: Array<{
    id: string;
    dnsName: string;
    recordType: 'A' | 'AAAA' | 'CNAME' | 'MX' | 'TXT' | 'NS';
    beforeAnswers: string[];
    afterAnswers: string[];
    beforeLocationEvidence: DnsLocationEvidence[];
    afterLocationEvidence: DnsLocationEvidence[];
    detectedAt: string;
    confirmedAt: string;
    configurationVersionId: string;
  }>;
  nextCursor: string | null;
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
