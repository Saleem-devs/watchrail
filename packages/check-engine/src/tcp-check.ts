import { TCP_CHECK_TIMEOUT_LIMITS } from '@watchrail/domain';
import { ProhibitedDestinationError, resolveSafeNetworkTarget } from './safe-network-target.js';
import type { TcpCheckDependencies, TcpCheckInput, TcpCheckResult } from './tcp-types.js';
import type { CheckClock } from './types.js';

const defaultClock: CheckClock = {
  now: () => new Date(),
  monotonicNow: () => performance.now(),
};

export async function executeTcpCheck(
  input: TcpCheckInput,
  dependencies: TcpCheckDependencies,
): Promise<TcpCheckResult> {
  assertTcpInput(input);
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
        reject(new TcpDeadlineExceededError());
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
      dependencies.connector.connect({
        host: target.hostname,
        port: input.port,
        addresses: target.addresses,
        signal: controller.signal,
      }),
      timeoutPromise,
    ]);
    if (result.type === 'CONNECTED') {
      return {
        outcome: 'PASS',
        stage: 'CONNECT',
        reason: 'CONNECTED',
        connectionTimeMs: result.connectionTimeMs,
        attemptDurationMs: elapsed(clock, startedAt),
        checkedAt,
      };
    }
    return {
      outcome: 'FAIL',
      stage: 'CONNECT',
      reason: result.type,
      connectionTimeMs: null,
      attemptDurationMs: elapsed(clock, startedAt),
      checkedAt,
    };
  } catch (error) {
    const timing = { attemptDurationMs: elapsed(clock, startedAt), checkedAt };
    if (deadlineExceeded || error instanceof TcpDeadlineExceededError) {
      return {
        ...timing,
        outcome: 'FAIL',
        stage: 'CONNECT',
        reason: 'CONNECTION_TIMEOUT',
        connectionTimeMs: null,
      };
    }
    if (error instanceof ProhibitedDestinationError) {
      return {
        ...timing,
        outcome: 'UNKNOWN',
        stage: 'DNS',
        reason: 'PROHIBITED_DESTINATION',
        connectionTimeMs: null,
      };
    }
    if (isNameNotFound(error)) {
      return {
        ...timing,
        outcome: 'FAIL',
        stage: 'DNS',
        reason: 'NAME_NOT_FOUND',
        connectionTimeMs: null,
      };
    }
    return {
      ...timing,
      outcome: 'UNKNOWN',
      stage: 'PROBE',
      reason: 'INTERNAL_ERROR',
      connectionTimeMs: null,
    };
  } finally {
    dependencies.signal?.removeEventListener('abort', cancelFromCaller);
    if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
  }
}

function assertTcpInput(input: TcpCheckInput): void {
  if (input.host.trim() === '') throw new TypeError('TCP host is required.');
  if (!Number.isInteger(input.port) || input.port < 1 || input.port > 65_535) {
    throw new RangeError('TCP port must be a whole number from 1 to 65535.');
  }
  if (
    !Number.isInteger(input.timeoutMs) ||
    input.timeoutMs < TCP_CHECK_TIMEOUT_LIMITS.minimumMs ||
    input.timeoutMs > TCP_CHECK_TIMEOUT_LIMITS.maximumMs
  ) {
    throw new RangeError(
      `TCP timeout must be from ${TCP_CHECK_TIMEOUT_LIMITS.minimumMs} to ${TCP_CHECK_TIMEOUT_LIMITS.maximumMs} milliseconds.`,
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

class TcpDeadlineExceededError extends Error {}
