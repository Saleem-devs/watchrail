import { brotliCompressSync, deflateSync, gzipSync } from 'node:zlib';
import { describe, expect, it, vi } from 'vitest';
import { executeHttpCheck } from './http-check.js';
import { NodeHttpExecutor } from './node-http-executor.js';
import type { DnsResolver } from './safe-http-target.js';
import { HTTP_BODY_CAPTURE_LIMIT_BYTES } from './types.js';
import {
  EncodedBodyTooLargeError,
  type HttpTransportResponse,
  type PinnedHttpTransport,
} from './undici-http-transport.js';

const resolver: DnsResolver = {
  lookup: () => Promise.resolve([{ address: '93.184.216.34', family: 4 }] as const),
};

function transportResponse(options: {
  statusCode?: number;
  location?: string | null;
  headers?: HttpTransportResponse['headers'];
  body?: Uint8Array;
  capture?: HttpTransportResponse['captureEncodedBody'];
}) {
  const discardBody = vi.fn(() => Promise.resolve());
  const captureEncodedBody = vi.fn(
    options.capture ?? (() => Promise.resolve(options.body ?? new Uint8Array())),
  );
  return {
    response: {
      statusCode: options.statusCode ?? 200,
      location: options.location ?? null,
      headers: options.headers ?? [],
      captureEncodedBody,
      discardBody,
    } satisfies HttpTransportResponse,
    captureEncodedBody,
    discardBody,
  };
}

function executorFor(...responses: HttpTransportResponse[]) {
  const request = vi.fn<PinnedHttpTransport['request']>();
  for (const response of responses) request.mockResolvedValueOnce(response);
  return { executor: new NodeHttpExecutor({ resolver, transport: { request } }), request };
}

describe('bounded response-body capture', () => {
  it('does not read a body unless capture is requested', async () => {
    const transport = transportResponse({ body: Buffer.from('secret') });
    const { executor } = executorFor(transport.response);

    const result = await executor.execute({
      url: 'https://example.com',
      method: 'GET',
      signal: new AbortController().signal,
    });

    expect(result).toMatchObject({ type: 'RESPONSE', body: { state: 'NOT_REQUESTED' } });
    expect(transport.captureEncodedBody).not.toHaveBeenCalled();
    expect(transport.discardBody).toHaveBeenCalledOnce();
  });

  it('never captures a HEAD response body', async () => {
    const transport = transportResponse({ body: Buffer.from('unexpected') });
    const { executor } = executorFor(transport.response);

    const result = await executor.execute({
      url: 'https://example.com',
      method: 'HEAD',
      signal: new AbortController().signal,
      captureResponseBody: true,
    });

    expect(result).toMatchObject({ type: 'RESPONSE', body: { state: 'NOT_REQUESTED' } });
    expect(transport.captureEncodedBody).not.toHaveBeenCalled();
  });

  it.each([
    ['small', Buffer.from('ready'), 'ready'],
    ['empty', new Uint8Array(), ''],
    [
      'exactly the limit',
      Buffer.alloc(HTTP_BODY_CAPTURE_LIMIT_BYTES, 97),
      'a'.repeat(HTTP_BODY_CAPTURE_LIMIT_BYTES),
    ],
  ])('captures and decodes an identity %s body', async (_case, body, expected) => {
    const transport = transportResponse({ body });
    const { executor } = executorFor(transport.response);

    const result = await executor.execute({
      url: 'https://example.com',
      method: 'GET',
      signal: new AbortController().signal,
      captureResponseBody: true,
    });

    expect(result).toMatchObject({ type: 'RESPONSE', body: { state: 'CAPTURED', text: expected } });
    expect(transport.captureEncodedBody).toHaveBeenCalledWith(HTTP_BODY_CAPTURE_LIMIT_BYTES);
  });

  it('classifies an encoded stream over the limit', async () => {
    const transport = transportResponse({
      capture: () => Promise.reject(new EncodedBodyTooLargeError()),
    });
    const { executor } = executorFor(transport.response);

    await expect(
      executor.execute({
        url: 'https://example.com',
        method: 'GET',
        signal: new AbortController().signal,
        captureResponseBody: true,
      }),
    ).resolves.toMatchObject({
      type: 'RESPONSE',
      body: { state: 'UNAVAILABLE', reason: 'BODY_TOO_LARGE' },
    });
  });

  it('does not trust an understated Content-Length instead of the stream counter', async () => {
    const transport = transportResponse({
      headers: [{ name: 'content-length', values: ['1'] }],
      capture: () => Promise.reject(new EncodedBodyTooLargeError()),
    });
    const { executor } = executorFor(transport.response);

    await expect(
      executor.execute({
        url: 'https://example.com',
        method: 'GET',
        signal: new AbortController().signal,
        captureResponseBody: true,
      }),
    ).resolves.toMatchObject({
      body: { state: 'UNAVAILABLE', reason: 'BODY_TOO_LARGE' },
    });
  });

  it('rejects an oversized valid Content-Length before reading', async () => {
    const transport = transportResponse({
      headers: [{ name: 'content-length', values: [String(HTTP_BODY_CAPTURE_LIMIT_BYTES + 1)] }],
    });
    const { executor } = executorFor(transport.response);

    const result = await executor.execute({
      url: 'https://example.com',
      method: 'GET',
      signal: new AbortController().signal,
      captureResponseBody: true,
    });

    expect(result).toMatchObject({
      type: 'RESPONSE',
      body: { state: 'UNAVAILABLE', reason: 'BODY_TOO_LARGE' },
    });
    expect(transport.captureEncodedBody).not.toHaveBeenCalled();
    expect(transport.discardBody).toHaveBeenCalledOnce();
  });

  it.each([
    ['gzip', gzipSync(Buffer.from('compressed response'))],
    ['deflate', deflateSync(Buffer.from('compressed response'))],
    ['br', brotliCompressSync(Buffer.from('compressed response'))],
  ] as const)('decodes %s bodies', async (encoding, body) => {
    const transport = transportResponse({
      body,
      headers: [{ name: 'content-encoding', values: [encoding] }],
    });
    const { executor } = executorFor(transport.response);

    await expect(
      executor.execute({
        url: 'https://example.com',
        method: 'GET',
        signal: new AbortController().signal,
        captureResponseBody: true,
      }),
    ).resolves.toMatchObject({
      type: 'RESPONSE',
      body: { state: 'CAPTURED', text: 'compressed response' },
    });
  });

  it('limits decompressed output independently of compressed input', async () => {
    const transport = transportResponse({
      body: gzipSync(Buffer.alloc(HTTP_BODY_CAPTURE_LIMIT_BYTES + 1, 97)),
      headers: [{ name: 'content-encoding', values: ['gzip'] }],
    });
    const { executor } = executorFor(transport.response);

    await expect(
      executor.execute({
        url: 'https://example.com',
        method: 'GET',
        signal: new AbortController().signal,
        captureResponseBody: true,
      }),
    ).resolves.toMatchObject({
      body: { state: 'UNAVAILABLE', reason: 'BODY_TOO_LARGE' },
    });
  });

  it.each([
    [[{ name: 'content-encoding', values: ['compress'] }], 'UNSUPPORTED_CONTENT_ENCODING'],
    [[{ name: 'content-encoding', values: ['gzip, br'] }], 'UNSUPPORTED_CONTENT_ENCODING'],
    [[{ name: 'content-type', values: ['text/plain; charset=iso-8859-1'] }], 'UNSUPPORTED_CHARSET'],
  ] as const)('rejects unsupported representation metadata', async (headers, reason) => {
    const transport = transportResponse({ headers });
    const { executor } = executorFor(transport.response);

    await expect(
      executor.execute({
        url: 'https://example.com',
        method: 'GET',
        signal: new AbortController().signal,
        captureResponseBody: true,
      }),
    ).resolves.toMatchObject({ body: { state: 'UNAVAILABLE', reason } });
    expect(transport.captureEncodedBody).not.toHaveBeenCalled();
  });

  it.each([
    ['invalid UTF-8', () => Promise.resolve(Uint8Array.of(0xc3, 0x28))],
    ['body read failure', () => Promise.reject(new Error('socket closed'))],
    ['invalid compressed stream', () => Promise.resolve(Buffer.from('not gzip'))],
  ])('classifies %s without exposing the failure or body', async (_case, capture) => {
    const headers =
      _case === 'invalid compressed stream' ? [{ name: 'content-encoding', values: ['gzip'] }] : [];
    const transport = transportResponse({ capture, headers });
    const { executor } = executorFor(transport.response);

    await expect(
      executor.execute({
        url: 'https://example.com',
        method: 'GET',
        signal: new AbortController().signal,
        captureResponseBody: true,
      }),
    ).resolves.toMatchObject({ body: { state: 'UNAVAILABLE', reason: 'BODY_READ_FAILED' } });
  });

  it('discards followed redirect bodies but captures a final response body', async () => {
    const redirect = transportResponse({
      statusCode: 302,
      location: '/final',
      body: Buffer.alloc(HTTP_BODY_CAPTURE_LIMIT_BYTES + 1),
    });
    const final = transportResponse({ body: Buffer.from('final') });
    const { executor } = executorFor(redirect.response, final.response);

    const result = await executor.execute({
      url: 'https://example.com/start',
      method: 'GET',
      signal: new AbortController().signal,
      followRedirects: true,
      captureResponseBody: true,
    });

    expect(redirect.captureEncodedBody).not.toHaveBeenCalled();
    expect(redirect.discardBody).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ body: { state: 'CAPTURED', text: 'final' } });
  });

  it('captures the first 3xx body when redirects are disabled', async () => {
    const redirect = transportResponse({
      statusCode: 302,
      location: '/ignored',
      body: Buffer.from('redirect explanation'),
    });
    const { executor, request } = executorFor(redirect.response);

    const result = await executor.execute({
      url: 'https://example.com/start',
      method: 'GET',
      signal: new AbortController().signal,
      followRedirects: false,
      captureResponseBody: true,
    });

    expect(request).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      statusCode: 302,
      body: { state: 'CAPTURED', text: 'redirect explanation' },
      redirects: [],
    });
  });

  it('keeps body capture under the attempt deadline', async () => {
    vi.useFakeTimers();
    try {
      const request = vi.fn<PinnedHttpTransport['request']>(({ signal }) =>
        Promise.resolve({
          statusCode: 200,
          location: null,
          headers: [],
          discardBody: () => Promise.resolve(),
          captureEncodedBody: () =>
            new Promise<Uint8Array>((_resolve, reject) => {
              signal.addEventListener(
                'abort',
                () => reject(new DOMException('The operation was aborted', 'AbortError')),
                { once: true },
              );
            }),
        }),
      );
      const nodeExecutor = new NodeHttpExecutor({ resolver, transport: { request } });
      const resultPromise = executeHttpCheck(
        {
          url: 'https://example.com',
          method: 'GET',
          timeoutMs: 1_000,
          followRedirects: true,
        },
        {
          executor: {
            execute: (input) => nodeExecutor.execute({ ...input, captureResponseBody: true }),
          },
          clock: { now: () => new Date(0), monotonicNow: () => Date.now() },
        },
      );

      await vi.advanceTimersByTimeAsync(1_000);
      await expect(resultPromise).resolves.toMatchObject({ reason: 'REQUEST_TIMEOUT' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('never copies captured body secrets into the durable check result', async () => {
    const secret = 'WATCHRAIL_BODY_SENTINEL_SECRET';
    const transport = transportResponse({ body: Buffer.from(secret) });
    const { executor } = executorFor(transport.response);
    const observation = await executor.execute({
      url: 'https://example.com',
      method: 'GET',
      signal: new AbortController().signal,
      captureResponseBody: true,
    });

    expect(JSON.stringify(observation)).toContain(secret);
    const checkResult = await executeHttpCheck(
      { url: 'https://example.com', method: 'GET', timeoutMs: 10_000, followRedirects: true },
      { executor: { execute: () => Promise.resolve(observation) } },
    );
    expect(JSON.stringify(checkResult)).not.toContain(secret);
  });
});
