import {
  InvalidHttpMethodError,
  InvalidHttpStatusPolicyError,
  InvalidHttpTimeoutError,
} from './errors.js';
import { HTTP_CHECK_TIMEOUT_LIMITS } from './types.js';
import type {
  CheckClock,
  HttpCheckDependencies,
  HttpCheckInput,
  HttpCheckResult,
  HttpExecutionResult,
  HttpMethod,
  HttpTargetFailure,
} from './types.js';

const defaultClock: CheckClock = {
  now: () => new Date(),
  monotonicNow: () => performance.now(),
};

const SUPPORTED_METHODS = new Set<HttpMethod>(['GET', 'HEAD']);

export async function executeHttpCheck(
  input: HttpCheckInput,
  dependencies: HttpCheckDependencies,
): Promise<HttpCheckResult> {
  assertSupportedMethod(input.method);
  assertValidTimeout(input.timeoutMs);
  assertValidStatusPolicy(input.statusPolicy);

  const clock = dependencies.clock ?? defaultClock;

  const checkedAt = clock.now();
  const startedAt = clock.monotonicNow();

  const controller = new AbortController();

  let deadlineExceeded = false;
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

  try {
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(() => {
        deadlineExceeded = true;
        controller.abort();
        reject(new RequestDeadlineExceededError());
      }, input.timeoutMs);
    });

    const executionPromise = dependencies.executor.execute({
      url: input.url,
      method: input.method,
      signal: controller.signal,
      requestHeaders: input.requestHeaders ?? [],
    });

    const execution = await Promise.race([executionPromise, timeoutPromise]);

    return classifyHttpExecution({
      execution,
      statusPolicy: input.statusPolicy ?? { type: 'ANY_2XX' },
      checkedAt,
      attemptDurationMs: elapsed(clock, startedAt),
    });
  } catch (error) {
    const attemptDurationMs = elapsed(clock, startedAt);

    if (deadlineExceeded || error instanceof RequestDeadlineExceededError) {
      return {
        outcome: 'FAIL',
        stage: 'HTTP',
        reason: 'REQUEST_TIMEOUT',
        statusCode: null,
        responseTimeMs: null,
        attemptDurationMs,
        checkedAt,
      };
    }

    return {
      outcome: 'UNKNOWN',
      stage: 'PROBE',
      reason: 'INTERNAL_ERROR',
      statusCode: null,
      responseTimeMs: null,
      attemptDurationMs,
      checkedAt,
    };
  } finally {
    if (timeoutHandle !== undefined) {
      clearTimeout(timeoutHandle);
    }
  }
}

function classifyHttpExecution(input: {
  execution: HttpExecutionResult;
  statusPolicy: NonNullable<HttpCheckInput['statusPolicy']>;
  checkedAt: Date;
  attemptDurationMs: number;
}): HttpCheckResult {
  const { execution, statusPolicy, checkedAt, attemptDurationMs } = input;

  if (execution.type === 'POLICY_REJECTION') {
    return {
      outcome: 'UNKNOWN',
      stage: execution.stage,
      reason: execution.reason,
      statusCode: null,
      responseTimeMs: null,
      attemptDurationMs,
      checkedAt,
    };
  }

  if (execution.type === 'REDIRECT_FAILURE') {
    return {
      outcome: 'FAIL',
      stage: 'HTTP',
      reason: execution.reason,
      statusCode: execution.statusCode,
      responseTimeMs: execution.responseTimeMs,
      attemptDurationMs,
      checkedAt,
    };
  }

  if (execution.type === 'TARGET_FAILURE') {
    return classifyTargetFailure({
      failure: execution,
      attemptDurationMs,
      checkedAt,
    });
  }

  const successful = statusMatches(statusPolicy, execution.statusCode);

  if (successful) {
    return {
      outcome: 'PASS',
      stage: 'HTTP',
      reason: 'COMPLETED',
      statusCode: execution.statusCode,
      responseTimeMs: execution.responseTimeMs,
      attemptDurationMs,
      checkedAt,
    };
  }

  return {
    outcome: 'FAIL',
    stage: 'HTTP',
    reason: 'UNEXPECTED_STATUS',
    statusCode: execution.statusCode,
    responseTimeMs: execution.responseTimeMs,
    attemptDurationMs,
    checkedAt,
  };
}

function statusMatches(
  policy: NonNullable<HttpCheckInput['statusPolicy']>,
  statusCode: number,
): boolean {
  return policy.type === 'ANY_2XX'
    ? statusCode >= 200 && statusCode <= 299
    : policy.statusCodes.includes(statusCode);
}

function classifyTargetFailure(input: {
  failure: HttpTargetFailure;
  checkedAt: Date;
  attemptDurationMs: number;
}): HttpCheckResult {
  const { failure, checkedAt, attemptDurationMs } = input;
  const common = {
    outcome: 'FAIL',
    statusCode: null,
    responseTimeMs: null,
    attemptDurationMs,
    checkedAt,
  } as const;

  switch (failure.stage) {
    case 'DNS':
      return { ...common, stage: 'DNS', reason: failure.reason };
    case 'CONNECT':
      return { ...common, stage: 'CONNECT', reason: failure.reason };
    case 'TLS':
      return { ...common, stage: 'TLS', reason: failure.reason };
  }
}

function assertSupportedMethod(method: unknown): asserts method is HttpMethod {
  if (!SUPPORTED_METHODS.has(method as HttpMethod)) {
    throw new InvalidHttpMethodError(method);
  }
}

function assertValidTimeout(timeoutMs: unknown): asserts timeoutMs is number {
  const { minMs, maxMs } = HTTP_CHECK_TIMEOUT_LIMITS;

  if (
    typeof timeoutMs !== 'number' ||
    !Number.isInteger(timeoutMs) ||
    timeoutMs < minMs ||
    timeoutMs > maxMs
  ) {
    throw new InvalidHttpTimeoutError(timeoutMs);
  }
}

function assertValidStatusPolicy(policy: HttpCheckInput['statusPolicy']): void {
  if (policy === undefined || policy.type === 'ANY_2XX') return;

  if (
    policy.type !== 'EXACT' ||
    policy.statusCodes.length === 0 ||
    policy.statusCodes.some((code) => !Number.isInteger(code) || code < 100 || code > 599)
  ) {
    throw new InvalidHttpStatusPolicyError();
  }
}

function elapsed(clock: CheckClock, startedAt: number): number {
  return Math.max(0, clock.monotonicNow() - startedAt);
}

class RequestDeadlineExceededError extends Error {
  constructor() {
    super('HTTP check exceeded its configured deadline');
    this.name = 'RequestDeadlineExceededError';
  }
}
