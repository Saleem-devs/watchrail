import { describe, expect, it, vi } from 'vitest';
import type { DnsResolver, PinnedHttpTransport } from '@watchrail/check-engine';
import { WebhookDeliveryEngine } from './webhook-delivery-engine.js';

const resolver: DnsResolver = {
  lookup: vi.fn(() => Promise.resolve([{ address: '93.184.216.34', family: 4 as const }])),
};

describe('WebhookDeliveryEngine', () => {
  it('posts the exact provided bytes once and never follows redirects', async () => {
    const body = Buffer.from('{"event":"exact"}', 'utf8');
    const request = vi.fn<PinnedHttpTransport['request']>((input) => {
      expect(input.method).toBe('POST');
      expect(input.body).toBe(body);
      return Promise.resolve(response(302));
    });
    const engine = new WebhookDeliveryEngine({ resolver, transport: { request } });
    await expect(
      engine.deliver({
        url: 'https://example.com/hook',
        body,
        headers: [{ name: 'content-type', value: 'application/json' }],
        timeoutMs: 1000,
      }),
    ).resolves.toEqual({ type: 'HTTP', statusCode: 302 });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('resolves and pins the target independently for every attempt', async () => {
    const lookup = vi
      .fn<DnsResolver['lookup']>()
      .mockResolvedValueOnce([{ address: '93.184.216.34', family: 4 }])
      .mockResolvedValueOnce([{ address: '93.184.216.35', family: 4 }]);
    const request = vi.fn<PinnedHttpTransport['request']>(() => Promise.resolve(response(204)));
    const engine = new WebhookDeliveryEngine({ resolver: { lookup }, transport: { request } });
    const input = {
      url: 'https://example.com',
      body: new Uint8Array(),
      headers: [],
      timeoutMs: 1000,
    };
    await engine.deliver(input);
    await engine.deliver(input);
    expect(lookup).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[0]![0].target.addresses[0]?.address).toBe('93.184.216.34');
    expect(request.mock.calls[1]![0].target.addresses[0]?.address).toBe('93.184.216.35');
  });

  it.each([
    'http://127.0.0.1/hook',
    'http://0.0.0.1/hook',
    'http://169.254.169.254/latest/meta-data',
    'http://10.0.0.1/hook',
    'http://192.0.2.1/hook',
    'http://[::1]/hook',
    'http://[fe80::1]/hook',
  ])('rejects prohibited target %s before transport', async (url) => {
    const request = vi.fn<PinnedHttpTransport['request']>();
    const engine = new WebhookDeliveryEngine({ transport: { request } });
    await expect(
      engine.deliver({ url, body: new Uint8Array(), headers: [], timeoutMs: 1000 }),
    ).resolves.toEqual({
      type: 'FAILURE',
      errorCode: 'PROHIBITED_DESTINATION',
      terminal: true,
    });
    expect(request).not.toHaveBeenCalled();
  });

  it('aborts one deadline covering resolution and transport', async () => {
    const engine = new WebhookDeliveryEngine({
      resolver: {
        lookup: () => new Promise(() => undefined),
      },
      transport: { request: vi.fn() },
    });
    await expect(
      engine.deliver({
        url: 'https://example.com',
        body: new Uint8Array(),
        headers: [],
        timeoutMs: 10,
      }),
    ).resolves.toEqual({ type: 'FAILURE', errorCode: 'REQUEST_TIMEOUT', terminal: false });
  });

  it('classifies invalid targets terminally and network failures as retryable', async () => {
    const request = vi.fn<PinnedHttpTransport['request']>(() =>
      Promise.reject(Object.assign(new Error('connect failed'), { code: 'ECONNREFUSED' })),
    );
    const engine = new WebhookDeliveryEngine({ resolver, transport: { request } });
    await expect(
      engine.deliver({
        url: 'ftp://example.com',
        body: new Uint8Array(),
        headers: [],
        timeoutMs: 1000,
      }),
    ).resolves.toMatchObject({ type: 'FAILURE', errorCode: 'INVALID_TARGET', terminal: true });
    await expect(
      engine.deliver({
        url: 'https://example.com',
        body: new Uint8Array(),
        headers: [],
        timeoutMs: 1000,
      }),
    ).resolves.toMatchObject({ type: 'FAILURE', errorCode: 'NETWORK_FAILURE', terminal: false });
  });
});

function response(statusCode: number) {
  return {
    statusCode,
    location: null,
    headers: [],
    captureEncodedBody: vi.fn(),
    discardBody: vi.fn(() => Promise.resolve()),
  };
}
