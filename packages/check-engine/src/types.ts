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

interface HttpCheckTiming {
  /**
   * Total monotonic elapsed time from attempt start until Watchrail has
   * completed the work required to classify the attempt.
   */
  attemptDurationMs: number;

  /** Wall-clock time at which the attempt started, before executor invocation. */
  checkedAt: Date;
}

interface HttpResponseEvidence {
  statusCode: number;

  /**
   * Monotonic elapsed time from initiating the outbound request until the
   * final HTTP response headers were received.
   */
  responseTimeMs: number;
}

type HttpTargetFailureClassification =
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

export type HttpCheckResult =
  | (HttpCheckTiming &
      HttpResponseEvidence & {
        outcome: 'PASS';
        stage: 'HTTP';
        reason: 'COMPLETED';
      })
  | (HttpCheckTiming &
      HttpResponseEvidence & {
        outcome: 'FAIL';
        stage: 'HTTP';
        reason: 'UNEXPECTED_STATUS';
      })
  | (HttpCheckTiming & {
      outcome: 'FAIL';
      stage: 'HTTP';
      reason: 'REQUEST_TIMEOUT';
      statusCode: null;
      responseTimeMs: null;
    })
  | (HttpCheckTiming &
      HttpTargetFailureClassification & {
        outcome: 'FAIL';
        statusCode: null;
        responseTimeMs: null;
      })
  | (HttpCheckTiming & {
      outcome: 'UNKNOWN';
      stage: 'PROBE';
      reason: 'INTERNAL_ERROR';
      statusCode: null;
      responseTimeMs: null;
    });

export type HttpCheckOutcome = HttpCheckResult['outcome'];
export type HttpCheckStage = HttpCheckResult['stage'];
export type HttpCheckReason = HttpCheckResult['reason'];

export interface HttpResponseObservation extends HttpResponseEvidence {
  type: 'RESPONSE';
}

export type HttpTargetFailure = { type: 'TARGET_FAILURE' } & HttpTargetFailureClassification;

/**
 * An observation about the configured target. Executors return expected
 * network failures; thrown exceptions are reserved for executor malfunctions.
 */
export type HttpExecutionResult = HttpResponseObservation | HttpTargetFailure;

export interface HttpExecutionInput {
  url: string;
  method: HttpMethod;

  /** Attempt-scoped cancellation signal controlled by the check engine. */
  signal: AbortSignal;
}

/**
 * Executors MUST observe signal cancellation and release network resources
 * promptly after abort. Expected target failures are returned as observations;
 * thrown exceptions indicate an executor or probe malfunction.
 */
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
