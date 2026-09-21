import { describe, expect, it, vi } from 'vitest';
import { executeHttpCheck } from './http-check.js';
import { InvalidHttpMethodError } from './index.js';
import type { HttpExecutionResult, HttpExecutor } from './index.js';

const checkedAt = new Date('2026-09-21T12:00:00.000Z');

function createClock() {
  let elapseMs = 0;

  return {
    now: () => checkedAt,
    monotonicNow: () => elapseMs,
    advance: (ms: number) => {
      elapseMs += ms;
    },
  };
}

describe('executeHttpCheck', () => {
  it('returns PASS / HTTP / COMPLETED for a 2xx response', async () => {
    const clock = createClock();

    const executor: HttpExecutor = {
      execute: vi.fn(() => {
        clock.advance(125);

        return Promise.resolve({
          statusCode: 200,
          responseTimeMs: 118,
        });
      }),
    };

    const result = await executeHttpCheck(
      {
        url: 'https://example.com',
        method: 'GET',
        timeoutMs: 10_000,
      },
      {
        executor,
        clock,
      },
    );

    expect(result).toEqual({
      outcome: 'PASS',
      stage: 'HTTP',
      reason: 'COMPLETED',
      statusCode: 200,
      responseTimeMs: 118,
      attemptDurationMs: 125,
      checkedAt,
    });
  });

  it('accepts any 2xx response', async () => {
    const clock = createClock();

    const executor: HttpExecutor = {
      execute: () =>
        Promise.resolve({
          statusCode: 204,
          responseTimeMs: 40,
        }),
    };

    const result = await executeHttpCheck(
      {
        url: 'https://example.com',
        method: 'HEAD',
        timeoutMs: 10_000,
      },
      {
        executor,
        clock,
      },
    );

    expect(result.outcome).toBe('PASS');
    expect(result.reason).toBe('COMPLETED');
    expect(result.statusCode).toBe(204);
  });

  it('returns FAIL / HTTP / UNEXPECTED_STATUS for a non-2xx response', async () => {
    const clock = createClock();

    const executor: HttpExecutor = {
      execute: vi.fn(() => {
        clock.advance(80);

        return Promise.resolve({
          statusCode: 503,
          responseTimeMs: 72,
        });
      }),
    };

    const result = await executeHttpCheck(
      {
        url: 'https://example.com',
        method: 'GET',
        timeoutMs: 10_000,
      },
      {
        executor,
        clock,
      },
    );

    expect(result).toEqual({
      outcome: 'FAIL',
      stage: 'HTTP',
      reason: 'UNEXPECTED_STATUS',
      statusCode: 503,
      responseTimeMs: 72,
      attemptDurationMs: 80,
      checkedAt,
    });
  });

  it('returns FAIL / HTTP / REQUEST_TIMEOUT when the deadline is exceeded', async () => {
    vi.useFakeTimers();

    try {
      const clock = createClock();

      const executor: HttpExecutor = {
        execute: vi.fn(
          () =>
            new Promise<HttpExecutionResult>(() => {
              // Intentionally never resolves.
            }),
        ),
      };

      const promise = executeHttpCheck(
        {
          url: 'https://example.com',
          method: 'GET',
          timeoutMs: 5_000,
        },
        {
          executor,
          clock: {
            now: clock.now,
            monotonicNow: () => Date.now(),
          },
        },
      );

      await vi.advanceTimersByTimeAsync(5_000);

      const result = await promise;

      expect(result).toMatchObject({
        outcome: 'FAIL',
        stage: 'HTTP',
        reason: 'REQUEST_TIMEOUT',
        statusCode: null,
        responseTimeMs: null,
      });

      expect(result.attemptDurationMs).toBeGreaterThanOrEqual(5_000);
    } finally {
      vi.useRealTimers();
    }
  });

  it('classifies an abort-aware executor as timed out after the deadline', async () => {
    vi.useFakeTimers();

    try {
      const executor: HttpExecutor = {
        execute: ({ signal }) =>
          new Promise<HttpExecutionResult>((_, reject) => {
            signal.addEventListener(
              'abort',
              () => {
                reject(new Error('request aborted'));
              },
              { once: true },
            );
          }),
      };

      const promise = executeHttpCheck(
        {
          url: 'https://example.com',
          method: 'GET',
          timeoutMs: 5_000,
        },
        {
          executor,
          clock: {
            now: () => checkedAt,
            monotonicNow: () => Date.now(),
          },
        },
      );

      await vi.advanceTimersByTimeAsync(5_000);

      await expect(promise).resolves.toMatchObject({
        outcome: 'FAIL',
        stage: 'HTTP',
        reason: 'REQUEST_TIMEOUT',
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('returns UNKNOWN / PROBE / INTERNAL_ERROR for an executor failure', async () => {
    const clock = createClock();

    const executor: HttpExecutor = {
      execute: vi.fn(() => {
        clock.advance(15);
        return Promise.reject(new Error('executor exploded'));
      }),
    };

    const result = await executeHttpCheck(
      {
        url: 'https://example.com',
        method: 'GET',
        timeoutMs: 10_000,
      },
      {
        executor,
        clock,
      },
    );

    expect(result).toEqual({
      outcome: 'UNKNOWN',
      stage: 'PROBE',
      reason: 'INTERNAL_ERROR',
      statusCode: null,
      responseTimeMs: null,
      attemptDurationMs: 15,
      checkedAt,
    });
  });

  it.each(['GET', 'HEAD'] as const)('accepts %s', async (method) => {
    const executor: HttpExecutor = {
      execute: () =>
        Promise.resolve({
          statusCode: 200,
          responseTimeMs: 10,
        }),
    };

    await expect(
      executeHttpCheck(
        {
          url: 'https://example.com',
          method,
          timeoutMs: 10_000,
        },
        {
          executor,
          clock: createClock(),
        },
      ),
    ).resolves.toMatchObject({
      outcome: 'PASS',
    });
  });

  it('rejects unsupported HTTP methods before executing the request', async () => {
    const execute = vi.fn<HttpExecutor['execute']>();
    const executor: HttpExecutor = {
      execute,
    };

    await expect(
      executeHttpCheck(
        {
          url: 'https://example.com',
          method: 'POST',
          timeoutMs: 10_000,
        } as never,
        {
          executor,
          clock: createClock(),
        },
      ),
    ).rejects.toBeInstanceOf(InvalidHttpMethodError);

    expect(execute).not.toHaveBeenCalled();
  });
});
