import { describe, expect, it, vi } from 'vitest';
import { executeHttpCheck } from './http-check.js';
import { NodeHttpExecutor } from './node-http-executor.js';
import type { DnsResolver } from './safe-http-target.js';
import type { HttpTransportResponse, PinnedHttpTransport } from './undici-http-transport.js';

const checkedAt = new Date('2026-09-21T12:00:00.000Z');

function createEngineClock() {
  return { now: () => checkedAt, monotonicNow: () => Date.now() };
}

function publicResolver(): DnsResolver {
  return {
    lookup: vi.fn(() => Promise.resolve([{ address: '93.184.216.34', family: 4 }] as const)),
  };
}

function response(
  statusCode: number,
  location: string | null = null,
  discardBody = vi.fn(() => Promise.resolve()),
) {
  return { statusCode, location, discardBody } satisfies HttpTransportResponse;
}

function transportReturning(result: HttpTransportResponse): PinnedHttpTransport {
  return { request: vi.fn(() => Promise.resolve(result)) };
}

function networkFailure(code: string): TypeError {
  const cause = Object.assign(new Error(code), { code });
  return new TypeError('request failed', { cause });
}

describe('NodeHttpExecutor', () => {
  it('returns a successful 200 response and measures time until headers arrive', async () => {
    let elapsed = 100;
    const transport: PinnedHttpTransport = {
      request: vi.fn(() => {
        elapsed = 137;
        return Promise.resolve(response(200));
      }),
    };
    const executor = new NodeHttpExecutor({
      resolver: publicResolver(),
      transport,
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
      redirects: [],
    });
  });

  it('passes only validated addresses and the original hostname to the transport', async () => {
    const resolver = publicResolver();
    const transport = transportReturning(response(200));
    const signal = new AbortController().signal;

    await new NodeHttpExecutor({ resolver, transport }).execute({
      url: 'https://example.com:8443/health?ready=true',
      method: 'HEAD',
      signal,
    });

    expect(resolver.lookup).toHaveBeenCalledOnce();
    expect(transport.request).toHaveBeenCalledWith({
      target: expect.objectContaining({
        hostname: 'example.com',
        port: 8443,
        addresses: [{ address: '93.184.216.34', family: 4 }],
      }),
      method: 'HEAD',
      signal,
      headers: [],
    });
  });

  it('lets the engine classify a 503 response as an unexpected status', async () => {
    const executor = new NodeHttpExecutor({
      resolver: publicResolver(),
      transport: transportReturning(response(503)),
    });
    const result = await executeHttpCheck(
      { url: 'https://example.com', method: 'GET', followRedirects: true, timeoutMs: 10_000 },
      { executor, clock: createEngineClock() },
    );

    expect(result).toMatchObject({
      outcome: 'FAIL',
      stage: 'HTTP',
      reason: 'UNEXPECTED_STATUS',
      statusCode: 503,
    });
  });

  it('passes the engine AbortSignal through DNS and transport work', async () => {
    vi.useFakeTimers();

    try {
      let receivedSignal: AbortSignal | undefined;
      const transport: PinnedHttpTransport = {
        request: vi.fn(({ signal }) => {
          receivedSignal = signal;
          return new Promise<HttpTransportResponse>((_resolve, reject) => {
            signal.addEventListener(
              'abort',
              () => reject(new DOMException('The operation was aborted', 'AbortError')),
              { once: true },
            );
          });
        }),
      };
      const executor = new NodeHttpExecutor({
        resolver: publicResolver(),
        transport,
        monotonicNow: () => Date.now(),
      });
      const resultPromise = executeHttpCheck(
        { url: 'https://example.com', method: 'GET', followRedirects: true, timeoutMs: 1_000 },
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

  it('translates DNS name-not-found into target evidence', async () => {
    const resolver: DnsResolver = {
      lookup: vi.fn(() => Promise.reject(networkFailure('ENOTFOUND'))),
    };
    const result = await executeHttpCheck(
      { url: 'https://missing.example', method: 'GET', followRedirects: true, timeoutMs: 10_000 },
      { executor: new NodeHttpExecutor({ resolver }), clock: createEngineClock() },
    );

    expect(result).toMatchObject({ outcome: 'FAIL', stage: 'DNS', reason: 'NAME_NOT_FOUND' });
  });

  it('classifies a prohibited destination as uncertainty rather than target failure', async () => {
    const resolver: DnsResolver = {
      lookup: vi.fn(() => Promise.resolve([{ address: '127.0.0.1', family: 4 }] as const)),
    };
    const result = await executeHttpCheck(
      { url: 'https://internal.example', method: 'GET', followRedirects: true, timeoutMs: 10_000 },
      { executor: new NodeHttpExecutor({ resolver }), clock: createEngineClock() },
    );

    expect(result).toMatchObject({
      outcome: 'UNKNOWN',
      stage: 'DNS',
      reason: 'PROHIBITED_DESTINATION',
    });
  });

  it.each([
    ['ECONNREFUSED', 'CONNECT', 'CONNECTION_REFUSED'],
    ['CERT_HAS_EXPIRED', 'TLS', 'CERTIFICATE_EXPIRED'],
  ] as const)('classifies %s network failure', async (code, stage, reason) => {
    const transport: PinnedHttpTransport = {
      request: vi.fn(() => Promise.reject(networkFailure(code))),
    };
    const result = await executeHttpCheck(
      { url: 'https://example.com', method: 'GET', followRedirects: true, timeoutMs: 10_000 },
      {
        executor: new NodeHttpExecutor({ resolver: publicResolver(), transport }),
        clock: createEngineClock(),
      },
    );

    expect(result).toMatchObject({ outcome: 'FAIL', stage, reason });
  });

  it('keeps unexpected executor errors as probe malfunctions', async () => {
    const transport: PinnedHttpTransport = {
      request: vi.fn(() => Promise.reject(new Error('unexpected executor failure'))),
    };
    const result = await executeHttpCheck(
      { url: 'https://example.com', method: 'GET', followRedirects: true, timeoutMs: 10_000 },
      {
        executor: new NodeHttpExecutor({ resolver: publicResolver(), transport }),
        clock: createEngineClock(),
      },
    );

    expect(result).toMatchObject({
      outcome: 'UNKNOWN',
      stage: 'PROBE',
      reason: 'INTERNAL_ERROR',
    });
  });

  it('follows a redirect and returns the final response', async () => {
    const request = vi
      .fn<PinnedHttpTransport['request']>()
      .mockResolvedValueOnce(response(302, '/final'))
      .mockResolvedValueOnce(response(200));
    const transport: PinnedHttpTransport = { request };
    const result = await executeHttpCheck(
      { url: 'https://example.com', method: 'GET', followRedirects: true, timeoutMs: 10_000 },
      {
        executor: new NodeHttpExecutor({ resolver: publicResolver(), transport }),
        clock: createEngineClock(),
      },
    );

    expect(request).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({
      outcome: 'PASS',
      stage: 'HTTP',
      reason: 'COMPLETED',
      statusCode: 200,
      redirects: [
        {
          sequence: 1,
          statusCode: 302,
          source: { targetId: 1, origin: 'https://example.com:443' },
          destination: { targetId: 2, origin: 'https://example.com:443' },
          headers: 'PRESERVED',
        },
      ],
    });
  });

  it.each([
    [{ type: 'ANY_2XX' } as const, 'FAIL', 'UNEXPECTED_STATUS'],
    [{ type: 'EXACT', statusCodes: [302] } as const, 'PASS', 'COMPLETED'],
  ] as const)(
    'treats a redirect as final when following is disabled for %o',
    async (statusPolicy, outcome, reason) => {
      const resolver = publicResolver();
      const request = vi
        .fn<PinnedHttpTransport['request']>()
        .mockResolvedValueOnce(response(302, '/final'));

      const result = await executeHttpCheck(
        {
          url: 'https://example.com/start',
          method: 'GET',
          timeoutMs: 10_000,
          followRedirects: false,
          statusPolicy,
        },
        {
          executor: new NodeHttpExecutor({ resolver, transport: { request } }),
          clock: createEngineClock(),
        },
      );

      expect(result).toMatchObject({ outcome, reason, statusCode: 302, redirects: [] });
      expect(resolver.lookup).toHaveBeenCalledOnce();
      expect(request).toHaveBeenCalledOnce();
    },
  );

  it.each([null, 'http://[invalid', 'http://127.0.0.1/private', 'http://example.com/insecure'])(
    'does not inspect redirect Location %s when following is disabled',
    async (location) => {
      const resolver = publicResolver();
      const request = vi
        .fn<PinnedHttpTransport['request']>()
        .mockResolvedValueOnce(response(302, location));

      const result = await executeHttpCheck(
        {
          url: 'https://example.com/start',
          method: 'GET',
          timeoutMs: 10_000,
          followRedirects: false,
          statusPolicy: { type: 'EXACT', statusCodes: [302] },
        },
        {
          executor: new NodeHttpExecutor({ resolver, transport: { request } }),
          clock: createEngineClock(),
        },
      );

      expect(result).toMatchObject({ outcome: 'PASS', statusCode: 302, redirects: [] });
      expect(resolver.lookup).toHaveBeenCalledOnce();
      expect(request).toHaveBeenCalledOnce();
    },
  );

  it('preserves HEAD across every redirect hop', async () => {
    const request = vi
      .fn<PinnedHttpTransport['request']>()
      .mockResolvedValueOnce(response(301, '/ready'))
      .mockResolvedValueOnce(response(204));

    const result = await executeHttpCheck(
      {
        url: 'https://example.com/health',
        method: 'HEAD',
        followRedirects: true,
        timeoutMs: 10_000,
      },
      {
        executor: new NodeHttpExecutor({
          resolver: publicResolver(),
          transport: { request },
        }),
        clock: createEngineClock(),
      },
    );

    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls.every(([call]) => call.method === 'HEAD')).toBe(true);
    expect(result).toMatchObject({ outcome: 'PASS', statusCode: 204 });
  });

  it('preserves configured headers on same-origin redirects', async () => {
    const request = vi
      .fn<PinnedHttpTransport['request']>()
      .mockResolvedValueOnce(response(302, '/final'))
      .mockResolvedValueOnce(response(200));
    const requestHeaders = [{ name: 'authorization', value: 'Bearer secret' }];

    await new NodeHttpExecutor({ resolver: publicResolver(), transport: { request } }).execute({
      url: 'https://example.com/start',
      method: 'GET',
      signal: new AbortController().signal,
      requestHeaders,
    });

    expect(request.mock.calls.map(([call]) => call.headers)).toEqual([
      requestHeaders,
      requestHeaders,
    ]);
  });

  it('strips configured headers permanently after a cross-origin redirect', async () => {
    const request = vi
      .fn<PinnedHttpTransport['request']>()
      .mockResolvedValueOnce(response(302, 'https://other.example/away'))
      .mockResolvedValueOnce(response(302, 'https://example.com/back'))
      .mockResolvedValueOnce(response(200));
    const requestHeaders = [{ name: 'authorization', value: 'Bearer secret' }];

    const result = await new NodeHttpExecutor({
      resolver: publicResolver(),
      transport: { request },
    }).execute({
      url: 'https://example.com/start',
      method: 'GET',
      signal: new AbortController().signal,
      requestHeaders,
    });

    expect(request.mock.calls.map(([call]) => call.headers)).toEqual([requestHeaders, [], []]);
    expect(result.redirects.map((hop) => hop.headers)).toEqual(['STRIPPED', 'STRIPPED']);
  });

  it('rejects an HTTPS to HTTP redirect before DNS resolution', async () => {
    const resolver = publicResolver();
    const request = vi
      .fn<PinnedHttpTransport['request']>()
      .mockResolvedValueOnce(response(302, 'http://example.com/insecure'));

    const result = await executeHttpCheck(
      {
        url: 'https://example.com/start',
        method: 'GET',
        followRedirects: true,
        timeoutMs: 10_000,
        requestHeaders: [{ name: 'authorization', value: 'Bearer secret' }],
      },
      {
        executor: new NodeHttpExecutor({ resolver, transport: { request } }),
        clock: createEngineClock(),
      },
    );

    expect(result).toMatchObject({
      outcome: 'FAIL',
      stage: 'HTTP',
      reason: 'INSECURE_REDIRECT',
      statusCode: 302,
      redirects: [
        expect.objectContaining({
          destination: { targetId: 2, origin: 'http://example.com:80' },
          headers: 'NOT_SENT',
        }),
      ],
    });
    expect(resolver.lookup).toHaveBeenCalledOnce();
    expect(request).toHaveBeenCalledOnce();
  });

  it('returns a final non-redirect failure after following redirects', async () => {
    const request = vi
      .fn<PinnedHttpTransport['request']>()
      .mockResolvedValueOnce(response(307, 'https://status.example/final'))
      .mockResolvedValueOnce(response(503));
    const result = await executeHttpCheck(
      { url: 'https://example.com/start', method: 'GET', followRedirects: true, timeoutMs: 10_000 },
      {
        executor: new NodeHttpExecutor({
          resolver: publicResolver(),
          transport: { request },
        }),
        clock: createEngineClock(),
      },
    );

    expect(result).toMatchObject({
      outcome: 'FAIL',
      reason: 'UNEXPECTED_STATUS',
      statusCode: 503,
    });
  });

  it('applies an exact status policy only to the final redirected response', async () => {
    const request = vi
      .fn<PinnedHttpTransport['request']>()
      .mockResolvedValueOnce(response(302, '/expected'))
      .mockResolvedValueOnce(response(404));
    const result = await executeHttpCheck(
      {
        url: 'https://example.com/start',
        method: 'GET',
        followRedirects: true,
        timeoutMs: 10_000,
        statusPolicy: { type: 'EXACT', statusCodes: [404] },
      },
      {
        executor: new NodeHttpExecutor({
          resolver: publicResolver(),
          transport: { request },
        }),
        clock: createEngineClock(),
      },
    );

    expect(result).toMatchObject({ outcome: 'PASS', statusCode: 404 });
  });

  it.each([
    [null, 'MISSING_REDIRECT_LOCATION'],
    ['', 'INVALID_REDIRECT_LOCATION'],
    ['ftp://example.com/file', 'INVALID_REDIRECT_LOCATION'],
    ['https://user:pass@example.com', 'INVALID_REDIRECT_LOCATION'],
    ['http://[invalid', 'INVALID_REDIRECT_LOCATION'],
  ] as const)('classifies redirect location %s as %s', async (location, reason) => {
    const result = await executeHttpCheck(
      { url: 'https://example.com', method: 'GET', followRedirects: true, timeoutMs: 10_000 },
      {
        executor: new NodeHttpExecutor({
          resolver: publicResolver(),
          transport: transportReturning(response(302, location)),
        }),
        clock: createEngineClock(),
      },
    );

    expect(result).toMatchObject({ outcome: 'FAIL', stage: 'HTTP', reason, statusCode: 302 });
    expect(result.redirects).toEqual([
      expect.objectContaining({ destination: null, headers: 'NOT_SENT' }),
    ]);
  });

  it('detects a redirect loop before resolving the visited target again', async () => {
    const resolver = publicResolver();
    const request = vi
      .fn<PinnedHttpTransport['request']>()
      .mockResolvedValueOnce(response(302, '/other'))
      .mockResolvedValueOnce(response(302, '/'));
    const result = await executeHttpCheck(
      { url: 'https://example.com/', method: 'GET', followRedirects: true, timeoutMs: 10_000 },
      {
        executor: new NodeHttpExecutor({ resolver, transport: { request } }),
        clock: createEngineClock(),
      },
    );

    expect(result).toMatchObject({ outcome: 'FAIL', reason: 'REDIRECT_LOOP' });
    expect(result.redirects).toMatchObject([
      {
        sequence: 1,
        source: { targetId: 1, origin: 'https://example.com:443' },
        destination: { targetId: 2, origin: 'https://example.com:443' },
        headers: 'PRESERVED',
      },
      {
        sequence: 2,
        source: { targetId: 2, origin: 'https://example.com:443' },
        destination: { targetId: 1, origin: 'https://example.com:443' },
        headers: 'NOT_SENT',
      },
    ]);
    expect(resolver.lookup).toHaveBeenCalledTimes(2);
  });

  it('allows five redirects and rejects a sixth', async () => {
    const request = vi.fn<PinnedHttpTransport['request']>();
    for (let hop = 1; hop <= 6; hop += 1) {
      request.mockResolvedValueOnce(response(302, `/hop-${hop}`));
    }
    const result = await executeHttpCheck(
      { url: 'https://example.com/start', method: 'GET', followRedirects: true, timeoutMs: 10_000 },
      {
        executor: new NodeHttpExecutor({
          resolver: publicResolver(),
          transport: { request },
        }),
        clock: createEngineClock(),
      },
    );

    expect(request).toHaveBeenCalledTimes(6);
    expect(result).toMatchObject({ outcome: 'FAIL', reason: 'TOO_MANY_REDIRECTS' });
    expect(result.redirects).toHaveLength(6);
    expect(result.redirects.map((hop) => hop.headers)).toEqual([
      'PRESERVED',
      'PRESERVED',
      'PRESERVED',
      'PRESERVED',
      'PRESERVED',
      'NOT_SENT',
    ]);
  });

  it('allows five redirects followed by a final response', async () => {
    const request = vi.fn<PinnedHttpTransport['request']>();
    for (let hop = 1; hop <= 5; hop += 1) {
      request.mockResolvedValueOnce(response(302, `/hop-${hop}`));
    }
    request.mockResolvedValueOnce(response(200));

    const result = await executeHttpCheck(
      { url: 'https://example.com/start', method: 'GET', followRedirects: true, timeoutMs: 10_000 },
      {
        executor: new NodeHttpExecutor({
          resolver: publicResolver(),
          transport: { request },
        }),
        clock: createEngineClock(),
      },
    );

    expect(request).toHaveBeenCalledTimes(6);
    expect(result).toMatchObject({ outcome: 'PASS', statusCode: 200 });
  });

  it('uses one deadline across the whole redirect chain', async () => {
    vi.useFakeTimers();

    try {
      const request = vi
        .fn<PinnedHttpTransport['request']>()
        .mockResolvedValueOnce(response(302, '/slow'))
        .mockImplementationOnce(
          ({ signal }) =>
            new Promise<HttpTransportResponse>((_resolve, reject) => {
              signal.addEventListener(
                'abort',
                () => reject(new DOMException('The operation was aborted', 'AbortError')),
                { once: true },
              );
            }),
        );
      const resultPromise = executeHttpCheck(
        {
          url: 'https://example.com/start',
          method: 'GET',
          followRedirects: true,
          timeoutMs: 1_000,
        },
        {
          executor: new NodeHttpExecutor({
            resolver: publicResolver(),
            transport: { request },
            monotonicNow: () => Date.now(),
          }),
          clock: createEngineClock(),
        },
      );

      await vi.advanceTimersByTimeAsync(1_000);

      const result = await resultPromise;

      expect(result).toMatchObject({
        outcome: 'FAIL',
        reason: 'REQUEST_TIMEOUT',
        redirects: [
          {
            sequence: 1,
            statusCode: 302,
            source: { targetId: 1, origin: 'https://example.com:443' },
            destination: { targetId: 2, origin: 'https://example.com:443' },
            headers: 'PRESERVED',
          },
        ],
      });
      expect(request).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('revalidates a redirect destination and rejects a prohibited address', async () => {
    const lookup = vi
      .fn<DnsResolver['lookup']>()
      .mockResolvedValueOnce([{ address: '93.184.216.34', family: 4 }])
      .mockResolvedValueOnce([{ address: '10.0.0.5', family: 4 }]);
    const request = vi
      .fn<PinnedHttpTransport['request']>()
      .mockResolvedValueOnce(response(302, 'https://internal.example/admin'));
    const result = await executeHttpCheck(
      { url: 'https://public.example', method: 'GET', followRedirects: true, timeoutMs: 10_000 },
      {
        executor: new NodeHttpExecutor({ resolver: { lookup }, transport: { request } }),
        clock: createEngineClock(),
      },
    );

    expect(result).toMatchObject({
      outcome: 'UNKNOWN',
      stage: 'DNS',
      reason: 'PROHIBITED_DESTINATION',
      redirects: [
        expect.objectContaining({
          destination: { targetId: 2, origin: 'https://internal.example:443' },
          headers: 'NOT_SENT',
        }),
      ],
    });
    expect(request).toHaveBeenCalledOnce();
  });

  it('keeps ordered per-hop timing and opaque endpoint identities without leaking URL secrets', async () => {
    const times = [0, 0, 10, 10, 30, 30, 60];
    const request = vi
      .fn<PinnedHttpTransport['request']>()
      .mockResolvedValueOnce(
        response(302, 'https://other.example/login?token=WATCHRAIL_QUERY_SECRET'),
      )
      .mockResolvedValueOnce(response(307, '/ready'))
      .mockResolvedValueOnce(response(204));
    const result = await new NodeHttpExecutor({
      resolver: publicResolver(),
      transport: { request },
      monotonicNow: () => times.shift() ?? 60,
    }).execute({
      url: 'https://example.com/invite/WATCHRAIL_PATH_SECRET',
      method: 'GET',
      signal: new AbortController().signal,
      requestHeaders: [{ name: 'authorization', value: 'WATCHRAIL_HEADER_SECRET' }],
    });

    expect(result).toEqual({
      type: 'RESPONSE',
      statusCode: 204,
      responseTimeMs: 60,
      redirects: [
        {
          sequence: 1,
          statusCode: 302,
          source: { targetId: 1, origin: 'https://example.com:443' },
          destination: { targetId: 2, origin: 'https://other.example:443' },
          responseTimeMs: 10,
          headers: 'STRIPPED',
        },
        {
          sequence: 2,
          statusCode: 307,
          source: { targetId: 2, origin: 'https://other.example:443' },
          destination: { targetId: 3, origin: 'https://other.example:443' },
          responseTimeMs: 20,
          headers: 'STRIPPED',
        },
      ],
    });

    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('WATCHRAIL_PATH_SECRET');
    expect(serialized).not.toContain('WATCHRAIL_QUERY_SECRET');
    expect(serialized).not.toContain('WATCHRAIL_HEADER_SECRET');
    expect(serialized).not.toContain('authorization');
    expect(serialized).not.toContain('93.184.216.34');
  });

  it('retains a NOT_SENT redirect hop when destination DNS fails', async () => {
    const lookup = vi
      .fn<DnsResolver['lookup']>()
      .mockResolvedValueOnce([{ address: '93.184.216.34', family: 4 }])
      .mockRejectedValueOnce(networkFailure('ENOTFOUND'));
    const request = vi
      .fn<PinnedHttpTransport['request']>()
      .mockResolvedValueOnce(response(302, 'https://missing.example/secret'));

    const result = await new NodeHttpExecutor({
      resolver: { lookup },
      transport: { request },
    }).execute({
      url: 'https://example.com/start',
      method: 'GET',
      signal: new AbortController().signal,
    });

    expect(result).toMatchObject({
      type: 'TARGET_FAILURE',
      stage: 'DNS',
      reason: 'NAME_NOT_FOUND',
      redirects: [
        expect.objectContaining({
          destination: { targetId: 2, origin: 'https://missing.example:443' },
          headers: 'NOT_SENT',
        }),
      ],
    });
    expect(request).toHaveBeenCalledOnce();
  });

  it('records STRIPPED when a cross-origin destination transport is invoked but connect fails', async () => {
    const request = vi
      .fn<PinnedHttpTransport['request']>()
      .mockResolvedValueOnce(response(302, 'https://other.example/final'))
      .mockRejectedValueOnce(networkFailure('ECONNREFUSED'));

    const result = await new NodeHttpExecutor({
      resolver: publicResolver(),
      transport: { request },
    }).execute({
      url: 'https://example.com/start',
      method: 'GET',
      signal: new AbortController().signal,
      requestHeaders: [{ name: 'authorization', value: 'Bearer secret' }],
    });

    expect(result).toMatchObject({
      type: 'TARGET_FAILURE',
      stage: 'CONNECT',
      redirects: [expect.objectContaining({ headers: 'STRIPPED' })],
    });
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('discards the unused response body after headers arrive', async () => {
    const discardBody = vi.fn(() => Promise.resolve());
    const executor = new NodeHttpExecutor({
      resolver: publicResolver(),
      transport: transportReturning(response(200, null, discardBody)),
    });

    await executor.execute({
      url: 'https://example.com',
      method: 'GET',
      signal: new AbortController().signal,
    });

    expect(discardBody).toHaveBeenCalledOnce();
  });

  it('preserves response evidence when response-body cleanup fails', async () => {
    const executor = new NodeHttpExecutor({
      resolver: publicResolver(),
      transport: transportReturning(
        response(
          200,
          null,
          vi.fn(() => Promise.reject(new Error('body cancellation failed'))),
        ),
      ),
    });
    const result = await executeHttpCheck(
      { url: 'https://example.com', method: 'GET', followRedirects: true, timeoutMs: 10_000 },
      { executor, clock: createEngineClock() },
    );

    expect(result).toMatchObject({ outcome: 'PASS', statusCode: 200 });
  });
});
