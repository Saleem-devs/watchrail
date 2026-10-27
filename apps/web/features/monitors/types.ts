/* Monitor feature API contracts. */
export interface Monitor {
  id: string;
  name: string;
  url: string;
  method: string;
  lifecycleState: 'ENABLED' | 'PAUSED';
  timeoutMs: number;
  followRedirects: boolean;
  statusPolicy: { type: 'ANY_2XX' } | { type: 'EXACT'; statusCodes: number[] };
  locations: string[];
  createdAt: string;
  currentCheck: CurrentCheck | null;
  incidentState: IncidentState;
  uptime: { uptimePercent: number | null; coveragePercent: number | null };
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
}

export interface ApiError {
  message?: string;
  fields?: FieldErrors;
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
        redirects: Array<{
          sequence: number;
          statusCode: 301 | 302 | 303 | 307 | 308;
          source: { targetId: number; origin: string };
          destination: { targetId: number; origin: string } | null;
          responseTimeMs: number;
          headers: 'PRESERVED' | 'STRIPPED' | 'NOT_SENT';
        }>;
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
