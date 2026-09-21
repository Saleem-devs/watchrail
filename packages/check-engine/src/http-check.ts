import {
  HttpTargetFailureError,
  InvalidHttpMethodError,
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
    });

    const execution = await Promise.race([executionPromise, timeoutPromise]);

    return classifyHttpResponse({
      execution,
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

    if (error instanceof HttpTargetFailureError) {
      return {
        outcome: 'FAIL',
        stage: error.failure.stage,
        reason: error.failure.reason,
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

function classifyHttpResponse(input: {
  execution: HttpExecutionResult;
  checkedAt: Date;
  attemptDurationMs: number;
}): HttpCheckResult {
  const { execution, checkedAt, attemptDurationMs } = input;

  const successful = execution.statusCode >= 200 && execution.statusCode <= 299;

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
function elapsed(clock: CheckClock, startedAt: number): number {

  return Math.max(0, clock.monotonicNow() - startedAt);
}

class RequestDeadlineExceededError extends Error {
  constructor() {
    super('HTTP check exceeded its configured deadline');
    this.name = 'RequestDeadlineExceededError';
  }
}
