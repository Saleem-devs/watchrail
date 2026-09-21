export const HTTP_CHECK_TIMEOUT_LIMITS = {
  minMs: 1_000,
  maxMs: 30_000,
} as const;

export type HttpMethod = 'GET' | 'HEAD';

export interface HttpCheckInput {
  url: string;
  method: HttpMethod;
  timeoutMs: number;
}

export type HttpCheckOutcome = 'PASS' | 'FAIL' | 'UNKNOWN';

export type HttpCheckStage = 'DNS' | 'CONNECT' | 'TLS' | 'HTTP' | 'PROBE';

export type HttpCheckReason =
  | 'COMPLETED'
  | 'UNEXPECTED_STATUS'
  | 'REQUEST_TIMEOUT'
  | 'NAME_NOT_FOUND'
  | 'CONNECTION_REFUSED'
  | 'CERTIFICATE_EXPIRED'
  | 'INTERNAL_ERROR';

export type HttpTargetFailure =
  | {
      stage: 'DNS';
      reason: 'NAME_NOT_FOUND';
    }
  | {
      stage: 'CONNECT';
      reason: 'CONNECTION_REFUSED';
    }
  | {
      stage: 'TLS';
      reason: 'CERTIFICATE_EXPIRED';
    };

export interface HttpCheckResult {
  outcome: HttpCheckOutcome;
  stage: HttpCheckStage;
  reason: HttpCheckReason;

  statusCode: number | null;
  responseTimeMs: number | null;

  attemptDurationMs: number;
  checkedAt: Date;
}

/**
 * Raw result from the network execution boundary
 *
 * This says nothing about whether Watchrail considers the
 * response successful. That remains check-engine policy
 */
export interface HttpExecutionResult {
  statusCode: number;
  responseTimeMs: number;
}

export interface HttpExecutionInput {
  url: string;
  method: HttpMethod;
  signal: AbortSignal;
}

export interface HttpExecutor {
  execute(input: HttpExecutionInput): Promise<HttpExecutionResult>;
}

export interface CheckClock {
  /**
   * Wall-clock time used for externally meaningful timestamps.
   */
  now(): Date;

  /**
   * Monotonic-ish time used only for measuring durations.
   */
  monotonicNow(): number;
}

export interface HttpCheckDependencies {
  executor: HttpExecutor;
  clock?: CheckClock;
}
