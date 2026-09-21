import { describe, expect, it, vi } from 'vitest';
import { executeHttpCheck } from './http-check.js';
import { NodeFetchHttpExecutor } from './local-http-executor.js';

const checkedAt = new Date('2026-09-21T12:00:00.000Z');

function createEngineClock() {
  return {
    now: () => checkedAt,
    monotonicNow: () => Date.now(),
  };
}

function fetchFailure(code: string): TypeError {
  const cause = Object.assign(new Error(code), { code });
  return new TypeError('fetch failed', { cause });
}

describe('NodeFetchHttpExecutor', () => {
  it('returns a successful 200 response and measures time until headers arrive', async () => {
    let elapsed = 100;

    const fetchImpl = vi.fn(() => {
      elapsed = 137;
      return Promise.resolve(new Response('ok', { status: 200 }));
    }) as typeof fetch;

    const executor = new NodeFetchHttpExecutor({
      fetchImpl,
      monotonicNow: () => elapsed,
    });

    const result = await executor.execute({
      url: 'https://example.com',
      method: 'GET',
      signal: new AbortController().signal,
    });

    expect(result).toEqual({
      type: 'RESPONSE',
      statusCode: 200,
      responseTimeMs: 37,
    });
  });

  it('lets the engine classify a 503 response as an unexpected status', async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(new Response('unavailable', { status: 503 })),
    ) as typeof fetch;
    const executor = new NodeFetchHttpExecutor({ fetchImpl });

    const result = await executeHttpCheck(
      { url: 'https://example.com', method: 'GET', timeoutMs: 10_000 },
      { executor, clock: createEngineClock() },
    );

    expect(result).toMatchObject({
      outcome: 'FAIL',
      stage: 'HTTP',
      reason: 'UNEXPECTED_STATUS',
      statusCode: 503,
    });
  });

  it('executes HEAD', async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(new Response(null, { status: 200 })),
    ) as typeof fetch;
    const executor = new NodeFetchHttpExecutor({ fetchImpl });

    await executor.execute({
      url: 'https://example.com/health',
      method: 'HEAD',
      signal: new AbortController().signal,
    });

    expect(fetchImpl).toHaveBeenCalledWith(
      'https://example.com/health',
      expect.objectContaining({ method: 'HEAD', redirect: 'manual' }),
    );
  });

  it('passes the engine AbortSignal to fetch so deadline cancellation aborts the request', async () => {
    vi.useFakeTimers();

    try {
      let receivedSignal: AbortSignal | undefined;

      const fetchImpl = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
        receivedSignal = init?.signal ?? undefined;

        return new Promise<Response>((_resolve, reject) => {
          receivedSignal?.addEventListener(
            'abort',
            () => reject(new DOMException('The operation was aborted', 'AbortError')),
            { once: true },
          );
        });
      }) as typeof fetch;

      const executor = new NodeFetchHttpExecutor({
        fetchImpl,
        monotonicNow: () => Date.now(),
      });

      const resultPromise = executeHttpCheck(
        { url: 'https://example.com', method: 'GET', timeoutMs: 1_000 },
        { executor, clock: createEngineClock() },
      );

      await vi.advanceTimersByTimeAsync(1_000);

      await expect(resultPromise).resolves.toMatchObject({
        outcome: 'FAIL',
        stage: 'HTTP',
        reason: 'REQUEST_TIMEOUT',
      });
      expect(receivedSignal?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('translates DNS lookup failure into target evidence', async () => {
    const fetchImpl = vi.fn(() => Promise.reject(fetchFailure('ENOTFOUND'))) as typeof fetch;

    const result = await executeHttpCheck(
      { url: 'https://missing.example', method: 'GET', timeoutMs: 10_000 },
      { executor: new NodeFetchHttpExecutor({ fetchImpl }), clock: createEngineClock() },
    );

    expect(result).toMatchObject({
      outcome: 'FAIL',
      stage: 'DNS',
      reason: 'NAME_NOT_FOUND',
    });
  });

  it('translates connection refusal into target evidence', async () => {
    const fetchImpl = vi.fn(() => Promise.reject(fetchFailure('ECONNREFUSED'))) as typeof fetch;

    const result = await executeHttpCheck(
      { url: 'http://127.0.0.1:65535', method: 'GET', timeoutMs: 10_000 },
      { executor: new NodeFetchHttpExecutor({ fetchImpl }), clock: createEngineClock() },
    );

    expect(result).toMatchObject({
      outcome: 'FAIL',
      stage: 'CONNECT',
      reason: 'CONNECTION_REFUSED',
    });
  });

  it('translates an expired TLS certificate into target evidence', async () => {
    const fetchImpl = vi.fn(() => Promise.reject(fetchFailure('CERT_HAS_EXPIRED'))) as typeof fetch;

    const result = await executeHttpCheck(
      { url: 'https://example.com', method: 'GET', timeoutMs: 10_000 },
      { executor: new NodeFetchHttpExecutor({ fetchImpl }), clock: createEngineClock() },
    );

    expect(result).toMatchObject({
      outcome: 'FAIL',
      stage: 'TLS',
      reason: 'CERTIFICATE_EXPIRED',
    });
  });

  it('keeps unexpected executor errors as probe malfunctions', async () => {
    const fetchImpl = vi.fn(() =>
      Promise.reject(new Error('unexpected executor failure')),
    ) as typeof fetch;

    const result = await executeHttpCheck(
      { url: 'https://example.com', method: 'GET', timeoutMs: 10_000 },
      { executor: new NodeFetchHttpExecutor({ fetchImpl }), clock: createEngineClock() },
    );

    expect(result).toMatchObject({
      outcome: 'UNKNOWN',
      stage: 'PROBE',
      reason: 'INTERNAL_ERROR',
    });
  });

  it('keeps redirect responses final while redirect handling is manual', async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(
        new Response(null, {
          status: 302,
          headers: { Location: 'https://example.com/next' },
        }),
      ),
    ) as typeof fetch;

    const result = await executeHttpCheck(
      { url: 'https://example.com', method: 'GET', timeoutMs: 10_000 },
      { executor: new NodeFetchHttpExecutor({ fetchImpl }), clock: createEngineClock() },
    );

    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      outcome: 'FAIL',
      stage: 'HTTP',
      reason: 'UNEXPECTED_STATUS',
      statusCode: 302,
    });
  });

  it('cancels an unused response body after headers arrive', async () => {
    let cancelled = false;

    const body = new ReadableStream({
      cancel() {
        cancelled = true;
      },
    });

    const fetchImpl = vi.fn(() =>
      Promise.resolve(new Response(body, { status: 200 })),
    ) as typeof fetch;
    const executor = new NodeFetchHttpExecutor({ fetchImpl });

    await executor.execute({
      url: 'https://example.com',
      method: 'GET',
      signal: new AbortController().signal,
    });

    expect(cancelled).toBe(true);
  });

  it('classifies response-body cleanup failure as a probe malfunction', async () => {
    const body = new ReadableStream({
      cancel() {
        return Promise.reject(new Error('body cancellation failed'));
      },
    });

    const fetchImpl = vi.fn(() =>
      Promise.resolve(new Response(body, { status: 200 })),
    ) as typeof fetch;

    const result = await executeHttpCheck(
      { url: 'https://example.com', method: 'GET', timeoutMs: 10_000 },
      { executor: new NodeFetchHttpExecutor({ fetchImpl }), clock: createEngineClock() },
    );

    expect(result).toMatchObject({
      outcome: 'UNKNOWN',
      stage: 'PROBE',
      reason: 'INTERNAL_ERROR',
    });
  });
});
