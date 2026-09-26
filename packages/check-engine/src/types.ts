export const HTTP_CHECK_TIMEOUT_LIMITS = {
  minMs: 1_000,
  maxMs: 30_000,
} as const;

export type HttpMethod = 'GET' | 'HEAD';
export type HttpStatusPolicy =
  { type: 'ANY_2XX' } | { type: 'EXACT'; statusCodes: readonly number[] };
export interface HttpRequestHeader {
  name: string;
  value: string;
}

export interface HttpCheckInput {
  url: string;
  method: HttpMethod;
  timeoutMs: number;
  followRedirects: boolean;
  statusPolicy?: HttpStatusPolicy;
  requestHeaders?: readonly HttpRequestHeader[];
}

interface HttpCheckTiming {
  /**
   * Total monotonic elapsed time from attempt start until Watchrail has
   * completed the work required to classify the attempt.
   */
  attemptDurationMs: number;

  /** Wall-clock time at which the attempt started, before executor invocation. */
  checkedAt: Date;
  redirects: readonly HttpRedirectHop[];
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
      reason:
        | 'CERTIFICATE_EXPIRED'
        | 'CERTIFICATE_NOT_YET_VALID'
        | 'CERTIFICATE_HOSTNAME_MISMATCH'
        | 'CERTIFICATE_UNTRUSTED'
        | 'TLS_HANDSHAKE_FAILED';
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
        reason:
          | 'UNEXPECTED_STATUS'
          | 'REDIRECT_LOOP'
          | 'TOO_MANY_REDIRECTS'
          | 'MISSING_REDIRECT_LOCATION'
          | 'INVALID_REDIRECT_LOCATION'
          | 'INSECURE_REDIRECT';
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
      stage: 'DNS';
      reason: 'PROHIBITED_DESTINATION';
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

export interface HttpExecutionEvidence {
  redirects: readonly HttpRedirectHop[];
}

export interface HttpResponseObservation extends HttpResponseEvidence, HttpExecutionEvidence {
  type: 'RESPONSE';
}

export type HttpTargetFailure = { type: 'TARGET_FAILURE' } & HttpTargetFailureClassification &
  HttpExecutionEvidence;

export interface HttpPolicyRejection extends HttpExecutionEvidence {
  type: 'POLICY_REJECTION';
  stage: 'DNS';
  reason: 'PROHIBITED_DESTINATION';
}

export interface HttpRedirectFailure extends HttpResponseEvidence, HttpExecutionEvidence {
  type: 'REDIRECT_FAILURE';
  reason:
    | 'REDIRECT_LOOP'
    | 'TOO_MANY_REDIRECTS'
    | 'MISSING_REDIRECT_LOCATION'
    | 'INVALID_REDIRECT_LOCATION'
    | 'INSECURE_REDIRECT';
}

/**
 * An observation about the configured target. Executors return expected
 * network failures; thrown exceptions are reserved for executor malfunctions.
 */
export type HttpExecutionResult =
  HttpResponseObservation | HttpTargetFailure | HttpPolicyRejection | HttpRedirectFailure;

export interface HttpExecutionInput {
  url: string;
  method: HttpMethod;

  /** Attempt-scoped cancellation signal controlled by the check engine. */
  signal: AbortSignal;
  followRedirects?: boolean;
  requestHeaders?: readonly HttpRequestHeader[];

  /**
   * Publishes sanitized evidence observed before an executor settles. The
   * engine uses the latest snapshot when it must synthesize a terminal result.
   */
  onEvidence?: (evidence: HttpExecutionEvidence) => void;
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
import type { HttpRedirectHop } from '@watchrail/domain';
