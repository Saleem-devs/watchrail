import {
  InvalidHttpMethodError,
  InvalidHttpStatusPolicyError,
  InvalidHttpTimeoutError,
} from './errors.js';
import { evaluateHeaderAssertions, notEvaluateHeaderAssertions } from './header-assertions.js';
import {
  evaluateJsonBodyAssertions,
  notEvaluateJsonBodyAssertions,
} from './json-body-assertions.js';
import {
  evaluateTextBodyAssertions,
  notEvaluateTextBodyAssertions,
} from './text-body-assertions.js';
import { HTTP_CHECK_TIMEOUT_LIMITS } from './types.js';
import type {
  CheckClock,
  HttpCheckDependencies,
  HttpCheckInput,
  HttpCheckResult,
  HttpExecutionResult,
  HttpFinalResponseEvidence,
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
  const headerAssertions = input.headerAssertions ?? [];
  const textBodyAssertions = input.textBodyAssertions ?? [];
  const jsonBodyAssertions = input.jsonBodyAssertions ?? [];
  assertValidAssertionConfiguration(
    input.method,
    headerAssertions,
    textBodyAssertions,
    jsonBodyAssertions,
  );
  const unavailableAssertions = combineAssertionEvaluations(
    notEvaluateHeaderAssertions(headerAssertions),
    notEvaluateTextBodyAssertions(textBodyAssertions),
    notEvaluateJsonBodyAssertions(jsonBodyAssertions),
  );

  const clock = dependencies.clock ?? defaultClock;

  const checkedAt = clock.now();
  const startedAt = clock.monotonicNow();

  const controller = new AbortController();
  let redirects: HttpCheckResult['redirects'] = [];
  let finalResponse: HttpFinalResponseEvidence | undefined;

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
      followRedirects: input.followRedirects,
      requestHeaders: input.requestHeaders ?? [],
      captureResponseBody: textBodyAssertions.length > 0 || jsonBodyAssertions.length > 0,
      onEvidence: (evidence) => {
        redirects = [...evidence.redirects];
        if (evidence.finalResponse !== undefined) {
          finalResponse = evidence.finalResponse;
        }
      },
    });

    const execution = await Promise.race([executionPromise, timeoutPromise]);

    return classifyHttpExecution({
      execution,
      statusPolicy: input.statusPolicy ?? { type: 'ANY_2XX' },
      headerAssertions: input.headerAssertions ?? [],
      textBodyAssertions,
      jsonBodyAssertions,
      checkedAt,
      attemptDurationMs: elapsed(clock, startedAt),
    });
  } catch (error) {
    const attemptDurationMs = elapsed(clock, startedAt);

    if (deadlineExceeded || error instanceof RequestDeadlineExceededError) {
      const responseEvidence = finalResponse;
      const timeoutResult = {
        outcome: 'FAIL',
        stage: 'HTTP',
        reason: 'REQUEST_TIMEOUT',
        attemptDurationMs,
        checkedAt,
        redirects,
        assertionEvaluation:
          responseEvidence === undefined
            ? unavailableAssertions
            : combineAssertionEvaluations(
                evaluateHeaderAssertions(headerAssertions, responseEvidence.headers),
                notEvaluateTextBodyAssertions(textBodyAssertions),
                notEvaluateJsonBodyAssertions(jsonBodyAssertions),
              ),
      } as const;
      return responseEvidence === undefined
        ? { ...timeoutResult, statusCode: null, responseTimeMs: null }
        : {
            ...timeoutResult,
            statusCode: responseEvidence.statusCode,
            responseTimeMs: responseEvidence.responseTimeMs,
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
      redirects,
      assertionEvaluation: unavailableAssertions,
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
  headerAssertions: NonNullable<HttpCheckInput['headerAssertions']>;
  textBodyAssertions: NonNullable<HttpCheckInput['textBodyAssertions']>;
  jsonBodyAssertions: NonNullable<HttpCheckInput['jsonBodyAssertions']>;
  checkedAt: Date;
  attemptDurationMs: number;
}): HttpCheckResult {
  const {
    execution,
    statusPolicy,
    headerAssertions,
    textBodyAssertions,
    jsonBodyAssertions,
    checkedAt,
    attemptDurationMs,
  } = input;
  const unavailableAssertions = combineAssertionEvaluations(
    notEvaluateHeaderAssertions(headerAssertions),
    notEvaluateTextBodyAssertions(textBodyAssertions),
    notEvaluateJsonBodyAssertions(jsonBodyAssertions),
  );

  if (execution.type === 'POLICY_REJECTION') {
    return {
      outcome: 'UNKNOWN',
      stage: execution.stage,
      reason: execution.reason,
      statusCode: null,
      responseTimeMs: null,
      attemptDurationMs,
      checkedAt,
      redirects: execution.redirects,
      assertionEvaluation: unavailableAssertions,
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
      redirects: execution.redirects,
      assertionEvaluation: unavailableAssertions,
    };
  }

  if (execution.type === 'TARGET_FAILURE') {
    return classifyTargetFailure({
      failure: execution,
      attemptDurationMs,
      checkedAt,
      assertionEvaluation: unavailableAssertions,
    });
  }

  const successful = statusMatches(statusPolicy, execution.statusCode);
  const assertionEvaluation = combineAssertionEvaluations(
    evaluateHeaderAssertions(headerAssertions, execution.headers),
    evaluateTextBodyAssertions(textBodyAssertions, execution.body),
    evaluateJsonBodyAssertions(jsonBodyAssertions, execution.body),
  );

  if (successful) {
    return {
      outcome: 'PASS',
      stage: 'HTTP',
      reason: 'COMPLETED',
      statusCode: execution.statusCode,
      responseTimeMs: execution.responseTimeMs,
      attemptDurationMs,
      checkedAt,
      redirects: execution.redirects,
      assertionEvaluation,
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
    redirects: execution.redirects,
    assertionEvaluation,
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
  assertionEvaluation: AssertionEvaluationV1;
}): HttpCheckResult {
  const { failure, checkedAt, attemptDurationMs, assertionEvaluation } = input;
  const common = {
    outcome: 'FAIL',
    statusCode: null,
    responseTimeMs: null,
    attemptDurationMs,
    checkedAt,
    redirects: failure.redirects,
    assertionEvaluation,
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

function assertValidAssertionConfiguration(
  method: HttpMethod,
  headerAssertions: NonNullable<HttpCheckInput['headerAssertions']>,
  textBodyAssertions: NonNullable<HttpCheckInput['textBodyAssertions']>,
  jsonBodyAssertions: NonNullable<HttpCheckInput['jsonBodyAssertions']>,
): void {
  if (
    headerAssertions.length + textBodyAssertions.length + jsonBodyAssertions.length >
    ASSERTION_LIMITS.maxAssertions
  ) {
    throw new AssertionInputError([
      `Configure at most ${ASSERTION_LIMITS.maxAssertions} assertions.`,
    ]);
  }
  assertAssertionsCompatibleWithMethod(method, {
    textBody: textBodyAssertions,
    jsonBody: jsonBodyAssertions,
  });
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
import {
  ASSERTION_LIMITS,
  AssertionInputError,
  assertAssertionsCompatibleWithMethod,
  type AssertionEvaluationV1,
} from '@watchrail/domain';
import { combineAssertionEvaluations } from './assertion-evaluation.js';
