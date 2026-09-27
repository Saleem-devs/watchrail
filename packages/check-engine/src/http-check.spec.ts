import { describe, expect, it, vi } from 'vitest';
import { executeHttpCheck } from './http-check.js';
import {
  HTTP_CHECK_TIMEOUT_LIMITS,
  InvalidHttpMethodError,
  InvalidHttpTimeoutError,
} from './index.js';
import type { HttpExecutionResult, HttpExecutor } from './index.js';

const checkedAt = new Date('2026-09-21T12:00:00.000Z');
const emptyAssertionEvaluation = { contractVersion: 1, outcome: 'PASS', diagnostics: [] } as const;

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
      execute: () => {
        clock.advance(125);

        return Promise.resolve({
          statusCode: 200,
          type: 'RESPONSE',
          headers: [],
          body: { state: 'NOT_REQUESTED' },
          redirects: [],
          responseTimeMs: 118,
        });
      },
    };

    const result = await executeHttpCheck(
      {
        url: 'https://example.com',
        method: 'GET',
        followRedirects: true,
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
      redirects: [],
      assertionEvaluation: emptyAssertionEvaluation,
    });
  });

  it('records checkedAt as the attempt start time', async () => {
    let wallClockTime = checkedAt;
    const completionTime = new Date('2026-09-21T12:00:05.000Z');

    const executor: HttpExecutor = {
      execute: () => {
        wallClockTime = completionTime;
        return Promise.resolve({
          type: 'RESPONSE',
          headers: [],
          body: { state: 'NOT_REQUESTED' },
          redirects: [],
          statusCode: 200,
          responseTimeMs: 5_000,
        });
      },
    };

    const result = await executeHttpCheck(
      {
        url: 'https://example.com',
        method: 'GET',
        followRedirects: true,
        timeoutMs: 10_000,
      },
      {
        executor,
        clock: {
          now: () => wallClockTime,
          monotonicNow: () => 0,
        },
      },
    );

    expect(result.checkedAt).toBe(checkedAt);
    expect(wallClockTime).toBe(completionTime);
  });

  it.each([200, 204, 299])('accepts %i as a successful response', async (statusCode) => {
    const clock = createClock();

    const executor: HttpExecutor = {
      execute: () =>
        Promise.resolve({
          statusCode,
          responseTimeMs: 40,
          type: 'RESPONSE',
          headers: [],
          body: { state: 'NOT_REQUESTED' },
          redirects: [],
        }),
    };

    const result = await executeHttpCheck(
      {
        url: 'https://example.com',
        method: 'HEAD',
        followRedirects: true,
        timeoutMs: 10_000,
      },
      {
        executor,
        clock,
      },
    );

    expect(result.outcome).toBe('PASS');
    expect(result.reason).toBe('COMPLETED');
    expect(result.statusCode).toBe(statusCode);
  });

  it('returns FAIL / HTTP / UNEXPECTED_STATUS for a non-2xx response', async () => {
    const clock = createClock();

    const executor: HttpExecutor = {
      execute: () => {
        clock.advance(80);

        return Promise.resolve({
          statusCode: 503,
          responseTimeMs: 72,
          type: 'RESPONSE',
          headers: [],
          body: { state: 'NOT_REQUESTED' },
          redirects: [],
        });
      },
    };

    const result = await executeHttpCheck(
      {
        url: 'https://example.com',
        method: 'GET',
        followRedirects: true,
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
      redirects: [],
      assertionEvaluation: emptyAssertionEvaluation,
    });
  });

  it('evaluates header assertions when a final response exists without changing status outcome', async () => {
    const executor: HttpExecutor = {
      execute: () =>
        Promise.resolve({
          type: 'RESPONSE',
          statusCode: 200,
          responseTimeMs: 10,
          headers: [{ name: 'x-state', values: ['not-ready'] }],
          body: { state: 'NOT_REQUESTED' },
          redirects: [],
        }),
    };

    const result = await executeHttpCheck(
      {
        url: 'https://example.com',
        method: 'GET',
        followRedirects: true,
        timeoutMs: 10_000,
        headerAssertions: [
          {
            name: 'x-state',
            operator: 'equals',
            target: { value: 'ready', sensitive: false },
          },
        ],
      },
      { executor, clock: createClock() },
    );

    expect(result).toMatchObject({
      outcome: 'PASS',
      reason: 'COMPLETED',
      assertionEvaluation: {
        outcome: 'FAIL',
        diagnostics: [{ outcome: 'FAIL', reason: 'HEADER_MISMATCH' }],
      },
    });
  });

  it.each([
    {
      type: 'TARGET_FAILURE',
      stage: 'DNS',
      reason: 'NAME_NOT_FOUND',
      redirects: [],
    },
    {
      type: 'TARGET_FAILURE',
      stage: 'CONNECT',
      reason: 'CONNECTION_REFUSED',
      redirects: [],
    },
    {
      type: 'TARGET_FAILURE',
      stage: 'TLS',
      reason: 'CERTIFICATE_UNTRUSTED',
      redirects: [],
    },
    {
      type: 'REDIRECT_FAILURE',
      reason: 'MISSING_REDIRECT_LOCATION',
      statusCode: 302,
      responseTimeMs: 10,
      redirects: [],
    },
  ] as const)('does not evaluate headers without a final response: $type', async (execution) => {
    const result = await executeHttpCheck(
      {
        url: 'https://example.com',
        method: 'GET',
        followRedirects: true,
        timeoutMs: 10_000,
        headerAssertions: [{ name: 'x-state', operator: 'exists' }],
      },
      { executor: { execute: () => Promise.resolve(execution) }, clock: createClock() },
    );

    expect(result.assertionEvaluation).toMatchObject({
      outcome: 'NOT_EVALUATED',
      diagnostics: [{ outcome: 'NOT_EVALUATED', reason: 'RESPONSE_UNAVAILABLE' }],
    });
  });

  it.each([
    [200, 'PASS'],
    [404, 'PASS'],
    [204, 'FAIL'],
  ] as const)('evaluates final status %i against an exact policy', async (statusCode, outcome) => {
    const executor: HttpExecutor = {
      execute: () =>
        Promise.resolve({
          type: 'RESPONSE',
          statusCode,
          responseTimeMs: 25,
          headers: [],
          body: { state: 'NOT_REQUESTED' },
          redirects: [],
        }),
    };

    const result = await executeHttpCheck(
      {
        url: 'https://example.com',
        method: 'GET',
        followRedirects: true,
        timeoutMs: 10_000,
        statusPolicy: { type: 'EXACT', statusCodes: [200, 404] },
      },
      { executor, clock: createClock() },
    );

    expect(result.outcome).toBe(outcome);
    expect(result.statusCode).toBe(statusCode);
  });

  it.each([199, 300])('rejects %i as a non-2xx response', async (statusCode) => {
    const executor: HttpExecutor = {
      execute: () =>
        Promise.resolve({
          statusCode,
          responseTimeMs: 40,
          type: 'RESPONSE',
          headers: [],
          body: { state: 'NOT_REQUESTED' },
          redirects: [],
        }),
    };

    const result = await executeHttpCheck(
      {
        url: 'https://example.com',
        method: 'GET',
        followRedirects: true,
        timeoutMs: 10_000,
      },
      {
        executor,
        clock: createClock(),
      },
    );

    expect(result).toMatchObject({
      outcome: 'FAIL',
      stage: 'HTTP',
      reason: 'UNEXPECTED_STATUS',
      statusCode,
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
          followRedirects: true,
          timeoutMs: 5_000,
          headerAssertions: [{ name: 'x-state', operator: 'exists' }],
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
        assertionEvaluation: {
          outcome: 'NOT_EVALUATED',
          diagnostics: [{ reason: 'RESPONSE_UNAVAILABLE' }],
        },
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
          followRedirects: true,
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

  it.each([
    { stage: 'DNS', reason: 'NAME_NOT_FOUND' },
    { stage: 'CONNECT', reason: 'CONNECTION_REFUSED' },
    { stage: 'TLS', reason: 'CERTIFICATE_EXPIRED' },
    { stage: 'TLS', reason: 'CERTIFICATE_NOT_YET_VALID' },
    { stage: 'TLS', reason: 'CERTIFICATE_HOSTNAME_MISMATCH' },
    { stage: 'TLS', reason: 'CERTIFICATE_UNTRUSTED' },
    { stage: 'TLS', reason: 'TLS_HANDSHAKE_FAILED' },
  ] as const)('returns FAIL / $stage / $reason for a target failure', async (failure) => {
    const clock = createClock();
    const executor: HttpExecutor = {
      execute: () => {
        clock.advance(25);
        return Promise.resolve({ type: 'TARGET_FAILURE', ...failure, redirects: [] });
      },
    };

    const result = await executeHttpCheck(
      {
        url: 'https://example.com',
        method: 'GET',
        followRedirects: true,
        timeoutMs: 10_000,
      },
      {
        executor,
        clock,
      },
    );

    expect(result).toEqual({
      outcome: 'FAIL',
      stage: failure.stage,
      reason: failure.reason,
      statusCode: null,
      responseTimeMs: null,
      attemptDurationMs: 25,
      checkedAt,
      redirects: [],
      assertionEvaluation: emptyAssertionEvaluation,
    });
  });

  it('returns UNKNOWN / DNS / PROHIBITED_DESTINATION for a policy rejection', async () => {
    const clock = createClock();
    const executor: HttpExecutor = {
      execute: () => {
        clock.advance(10);
        return Promise.resolve({
          type: 'POLICY_REJECTION',
          redirects: [],
          stage: 'DNS',
          reason: 'PROHIBITED_DESTINATION',
        });
      },
    };

    const result = await executeHttpCheck(
      { url: 'http://127.0.0.1', method: 'GET', followRedirects: true, timeoutMs: 10_000 },
      { executor, clock },
    );

    expect(result).toEqual({
      outcome: 'UNKNOWN',
      stage: 'DNS',
      reason: 'PROHIBITED_DESTINATION',
      statusCode: null,
      responseTimeMs: null,
      attemptDurationMs: 10,
      checkedAt,
      redirects: [],
      assertionEvaluation: emptyAssertionEvaluation,
    });
  });

  it('returns UNKNOWN / PROBE / INTERNAL_ERROR for an executor failure', async () => {
    const clock = createClock();
    const redirects = [
      {
        sequence: 1,
        statusCode: 302 as const,
        source: { targetId: 1, origin: 'https://example.com:443' },
        destination: { targetId: 2, origin: 'https://example.com:443' },
        responseTimeMs: 10,
        headers: 'PRESERVED' as const,
      },
    ];

    const executor: HttpExecutor = {
      execute: vi.fn((input) => {
        input.onEvidence?.({ redirects });
        clock.advance(15);
        return Promise.reject(new Error('executor exploded'));
      }),
    };

    const result = await executeHttpCheck(
      {
        url: 'https://example.com',
        method: 'GET',
        followRedirects: true,
        timeoutMs: 10_000,
        headerAssertions: [{ name: 'x-state', operator: 'exists' }],
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
      redirects,
      assertionEvaluation: {
        contractVersion: 1,
        outcome: 'NOT_EVALUATED',
        diagnostics: [
          {
            index: 0,
            source: 'HEADER',
            subject: 'x-state',
            operator: 'exists',
            outcome: 'NOT_EVALUATED',
            reason: 'RESPONSE_UNAVAILABLE',
          },
        ],
      },
    });
  });

  it.each([0, 999, 30_001, 1_000.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects invalid timeout %s before executing the request',
    async (timeoutMs) => {
      const execute = vi.fn<HttpExecutor['execute']>();

      await expect(
        executeHttpCheck(
          {
            url: 'https://example.com',
            method: 'GET',
            followRedirects: true,
            timeoutMs,
          },
          {
            executor: { execute },
            clock: createClock(),
          },
        ),
      ).rejects.toBeInstanceOf(InvalidHttpTimeoutError);

      expect(execute).not.toHaveBeenCalled();
    },
  );

  it.each([HTTP_CHECK_TIMEOUT_LIMITS.minMs, HTTP_CHECK_TIMEOUT_LIMITS.maxMs])(
    'accepts timeout boundary %i ms',
    async (timeoutMs) => {
      const executor: HttpExecutor = {
        execute: () =>
          Promise.resolve({
            statusCode: 200,
            responseTimeMs: 10,
            type: 'RESPONSE',
            headers: [],
            body: { state: 'NOT_REQUESTED' },
            redirects: [],
          }),
      };

      await expect(
        executeHttpCheck(
          {
            url: 'https://example.com',
            method: 'GET',
            followRedirects: true,
            timeoutMs,
          },
          {
            executor,
            clock: createClock(),
          },
        ),
      ).resolves.toMatchObject({ outcome: 'PASS' });
    },
  );

  it.each(['GET', 'HEAD'] as const)('accepts %s', async (method) => {
    const executor: HttpExecutor = {
      execute: () =>
        Promise.resolve({
          statusCode: 200,
          responseTimeMs: 10,
          type: 'RESPONSE',
          headers: [],
          body: { state: 'NOT_REQUESTED' },
          redirects: [],
        }),
    };

    await expect(
      executeHttpCheck(
        {
          url: 'https://example.com',
          method,
          followRedirects: true,
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
          followRedirects: true,
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
