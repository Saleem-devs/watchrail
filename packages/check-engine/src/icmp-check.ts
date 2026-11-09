import { ICMP_CHECK_TIMEOUT_LIMITS } from '@watchrail/domain';
import { ProhibitedDestinationError, resolveSafeNetworkTarget } from './safe-network-target.js';
import type { IcmpCheckDependencies, IcmpCheckInput, IcmpCheckResult } from './icmp-types.js';
import type { CheckClock } from './types.js';

const defaultClock: CheckClock = {
  now: () => new Date(),
  monotonicNow: () => performance.now(),
};

export async function executeIcmpCheck(
  input: IcmpCheckInput,
  dependencies: IcmpCheckDependencies,
): Promise<IcmpCheckResult> {
  assertIcmpInput(input);
  const clock = dependencies.clock ?? defaultClock;
  const checkedAt = clock.now();
  const startedAt = clock.monotonicNow();
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
        reject(new IcmpDeadlineExceededError());
      }, input.timeoutMs);
    });
    const target = await Promise.race([
      resolveSafeNetworkTarget(input.host, {
        signal: controller.signal,
        ...(dependencies.resolver === undefined ? {} : { resolver: dependencies.resolver }),
      }),
      timeoutPromise,
    ]);
    const result = await Promise.race([
      dependencies.pinger.ping({
        host: target.hostname,
        addresses: target.addresses,
        signal: controller.signal,
      }),
      timeoutPromise,
    ]);
    if (result.type === 'REPLY') {
      return {
        outcome: 'PASS',
        stage: 'ICMP',
        reason: 'PING_REPLIED',
        responseTimeMs: result.responseTimeMs,
        attemptDurationMs: elapsed(clock, startedAt),
        checkedAt,
      };
    }
    if (result.type === 'ICMP_UNAVAILABLE') {
      return {
        outcome: 'UNKNOWN',
        stage: 'PROBE',
        reason: 'ICMP_UNAVAILABLE',
        responseTimeMs: null,
        attemptDurationMs: elapsed(clock, startedAt),
        checkedAt,
      };
    }
    return {
      outcome: 'FAIL',
      stage: 'ICMP',
      reason: 'PING_HOST_UNREACHABLE',
      responseTimeMs: null,
      attemptDurationMs: elapsed(clock, startedAt),
      checkedAt,
    };
  } catch (error) {
    const timing = { attemptDurationMs: elapsed(clock, startedAt), checkedAt };
    if (deadlineExceeded || error instanceof IcmpDeadlineExceededError) {
      return {
        ...timing,
        outcome: 'FAIL',
        stage: 'ICMP',
        reason: 'PING_TIMEOUT',
        responseTimeMs: null,
      };
    }
    if (error instanceof ProhibitedDestinationError) {
      return {
        ...timing,
        outcome: 'UNKNOWN',
        stage: 'DNS',
        reason: 'PROHIBITED_DESTINATION',
        responseTimeMs: null,
      };
    }
    if (isNameNotFound(error)) {
      return {
        ...timing,
        outcome: 'FAIL',
        stage: 'DNS',
        reason: 'NAME_NOT_FOUND',
        responseTimeMs: null,
      };
    }
    return {
      ...timing,
      outcome: 'UNKNOWN',
      stage: 'PROBE',
      reason: 'INTERNAL_ERROR',
      responseTimeMs: null,
    };
  } finally {
    dependencies.signal?.removeEventListener('abort', cancelFromCaller);
    if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
  }
}

function assertIcmpInput(input: IcmpCheckInput): void {
  if (input.host.trim() === '') throw new TypeError('ICMP host is required.');
  if (
    !Number.isInteger(input.timeoutMs) ||
    input.timeoutMs < ICMP_CHECK_TIMEOUT_LIMITS.minimumMs ||
    input.timeoutMs > ICMP_CHECK_TIMEOUT_LIMITS.maximumMs
  ) {
    throw new RangeError(
      `ICMP timeout must be from ${ICMP_CHECK_TIMEOUT_LIMITS.minimumMs} to ${ICMP_CHECK_TIMEOUT_LIMITS.maximumMs} milliseconds.`,
    );
  }
}

function elapsed(clock: CheckClock, startedAt: number): number {
  return Math.max(0, Math.round(clock.monotonicNow() - startedAt));
}

function isNameNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOTFOUND'
  );
}

class IcmpDeadlineExceededError extends Error {}
