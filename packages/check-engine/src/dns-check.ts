import {
  DNS_CHECK_TIMEOUT_LIMITS,
  DNS_EXPECTED_VALUE_LIMITS,
  DNS_RECORD_TYPES,
  normalizeDnsAnswer,
} from '@watchrail/domain';
import type { DnsCheckDependencies, DnsCheckInput, DnsCheckResult } from './dns-types.js';
import type { CheckClock } from './types.js';

const MAX_RETAINED_ANSWERS = 32;
const MAX_OBSERVED_ANSWERS = 256;

const defaultClock: CheckClock = {
  now: () => new Date(),
  monotonicNow: () => performance.now(),
};

export async function executeDnsCheck(
  input: DnsCheckInput,
  dependencies: DnsCheckDependencies,
): Promise<DnsCheckResult> {
  assertDnsInput(input);
  const clock = dependencies.clock ?? defaultClock;
  const checkedAt = clock.now();
  const startedAt = clock.monotonicNow();
  const queryStartedAt = clock.monotonicNow();
  const controller = new AbortController();
  let deadlineExceeded = false;
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const cancelFromCaller = () => controller.abort(dependencies.signal?.reason);
  if (dependencies.signal?.aborted) cancelFromCaller();
  else dependencies.signal?.addEventListener('abort', cancelFromCaller, { once: true });

  try {
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(() => {
        deadlineExceeded = true;
        controller.abort();
        reject(new DnsDeadlineExceededError());
      }, input.timeoutMs);
    });
    const rawAnswers = await Promise.race([
      dependencies.resolver.resolve({
        name: input.name,
        recordType: input.recordType,
        signal: controller.signal,
      }),
      timeoutPromise,
    ]);
    const queryTimeMs = elapsed(clock, queryStartedAt);
    const normalizedAnswers = normalizeAnswers(input.recordType, rawAnswers);
    const answers = normalizedAnswers.slice(0, MAX_RETAINED_ANSWERS);
    const timing = { attemptDurationMs: elapsed(clock, startedAt), checkedAt };
    if (answers.length === 0) {
      return {
        ...timing,
        outcome: 'FAIL',
        stage: 'DNS',
        reason: 'NO_RECORDS',
        queryTimeMs,
        answers: [],
      };
    }
    const expected = normalizeAnswers(input.recordType, input.expectedValues);
    if (expected.length > 0 && !expected.every((value) => normalizedAnswers.includes(value))) {
      return {
        ...timing,
        outcome: 'FAIL',
        stage: 'DNS',
        reason: 'RECORD_MISMATCH',
        queryTimeMs,
        answers,
      };
    }
    return {
      ...timing,
      outcome: 'PASS',
      stage: 'DNS',
      reason: 'RECORDS_MATCHED',
      queryTimeMs,
      answers,
    };
  } catch (error) {
    const timing = { attemptDurationMs: elapsed(clock, startedAt), checkedAt };
    if (
      deadlineExceeded ||
      error instanceof DnsDeadlineExceededError ||
      hasCode(error, 'ETIMEOUT')
    ) {
      return {
        ...timing,
        outcome: 'FAIL',
        stage: 'DNS',
        reason: 'DNS_TIMEOUT',
        queryTimeMs: null,
        answers: [],
      };
    }
    if (hasCode(error, 'ENOTFOUND')) {
      return {
        ...timing,
        outcome: 'FAIL',
        stage: 'DNS',
        reason: 'NAME_NOT_FOUND',
        queryTimeMs: null,
        answers: [],
      };
    }
    if (hasCode(error, 'ENODATA')) {
      return {
        ...timing,
        outcome: 'FAIL',
        stage: 'DNS',
        reason: 'NO_RECORDS',
        queryTimeMs: elapsed(clock, queryStartedAt),
        answers: [],
      };
    }
    return {
      ...timing,
      outcome: 'UNKNOWN',
      stage: 'PROBE',
      reason: 'INTERNAL_ERROR',
      queryTimeMs: null,
      answers: [],
    };
  } finally {
    dependencies.signal?.removeEventListener('abort', cancelFromCaller);
    if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
  }
}

function assertDnsInput(input: DnsCheckInput): void {
  if (input.name.trim() === '') throw new TypeError('DNS name is required.');
  if (!DNS_RECORD_TYPES.includes(input.recordType))
    throw new TypeError('DNS record type is invalid.');
  if (
    !Number.isInteger(input.timeoutMs) ||
    input.timeoutMs < DNS_CHECK_TIMEOUT_LIMITS.minimumMs ||
    input.timeoutMs > DNS_CHECK_TIMEOUT_LIMITS.maximumMs
  ) {
    throw new RangeError(
      `DNS timeout must be from ${DNS_CHECK_TIMEOUT_LIMITS.minimumMs} to ${DNS_CHECK_TIMEOUT_LIMITS.maximumMs} milliseconds.`,
    );
  }
  if (input.expectedValues.length > DNS_EXPECTED_VALUE_LIMITS.maximumCount) {
    throw new RangeError('Too many expected DNS values.');
  }
  if (
    input.expectedValues.some(
      (value) => value.trim() === '' || value.length > DNS_EXPECTED_VALUE_LIMITS.maximumLength,
    )
  ) {
    throw new RangeError('Expected DNS values are invalid.');
  }
}

function normalizeAnswers(
  recordType: DnsCheckInput['recordType'],
  values: readonly string[],
): string[] {
  if (values.length > MAX_OBSERVED_ANSWERS) throw new DnsEvidenceLimitError();
  const normalized = values.map((value) => normalizeDnsAnswer(recordType, value)).filter(Boolean);
  if (normalized.some((value) => value.length > DNS_EXPECTED_VALUE_LIMITS.maximumLength)) {
    throw new DnsEvidenceLimitError();
  }
  return [...new Set(normalized)].sort();
}

function elapsed(clock: CheckClock, startedAt: number): number {
  return Math.max(0, Math.round(clock.monotonicNow() - startedAt));
}

function hasCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}

class DnsDeadlineExceededError extends Error {}
class DnsEvidenceLimitError extends Error {}
