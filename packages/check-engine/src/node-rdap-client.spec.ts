import { describe, expect, it, vi } from 'vitest';
import { RdapUnsupportedTldError } from './domain-expiry-types.js';
import { NodeRdapDomainClient } from './node-rdap-client.js';
import type { DnsResolver } from './safe-http-target.js';
import {
  EncodedBodyTooLargeError,
  type HttpTransportResponse,
  type PinnedHttpTransport,
} from './undici-http-transport.js';

const resolver: DnsResolver = {
  lookup: vi.fn(() => Promise.resolve([{ address: '93.184.216.34', family: 4 as const }])),
};

describe('NodeRdapDomainClient', () => {
  it('uses the IANA bootstrap service and reads the RDAP expiration event', async () => {
    const request = transportRequests([
      jsonResponse({
        services: [[['com'], ['http://insecure.example/', 'https://rdap.example/']]],
      }),
      jsonResponse(
        domainResponse('example.com', [
          { eventAction: 'registration', eventDate: '2020-01-01T00:00:00Z' },
          { eventAction: 'expiration', eventDate: '2027-01-02T03:04:05Z' },
        ]),
      ),
    ]);

    const result = await new NodeRdapDomainClient({ resolver, transport: { request } }).lookup(
      'example.com',
      new AbortController().signal,
    );

    expect(result).toEqual({
      expirationDate: new Date('2027-01-02T03:04:05Z'),
      sourceUrl: 'https://rdap.example/domain/example.com',
    });
    expect(request).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        target: expect.objectContaining({
          url: new URL('https://rdap.example/domain/example.com'),
          addresses: [{ address: '93.184.216.34', family: 4 }],
        }),
      }),
    );
  });

  it('rejects a TLD that has no HTTPS RDAP service', async () => {
    const request = transportRequests([
      jsonResponse({ services: [[['com'], ['https://rdap.example/']]] }),
    ]);

    await expect(
      new NodeRdapDomainClient({ resolver, transport: { request } }).lookup(
        'example.invalid',
        new AbortController().signal,
      ),
    ).rejects.toBeInstanceOf(RdapUnsupportedTldError);
  });

  it('uses label-wise longest-suffix bootstrap matching', async () => {
    const request = transportRequests([
      jsonResponse({
        services: [
          [['com'], ['https://rdap-tld.example/']],
          [['example.com'], ['https://rdap-specific.example/']],
        ],
      }),
      jsonResponse(
        domainResponse('a.example.com', [
          { eventAction: 'expiration', eventDate: '2027-01-02T03:04:05Z' },
        ]),
      ),
    ]);

    const result = await new NodeRdapDomainClient({ resolver, transport: { request } }).lookup(
      'a.example.com',
      new AbortController().signal,
    );

    expect(result.sourceUrl).toBe('https://rdap-specific.example/domain/a.example.com');
  });

  it.each([
    ['a mismatched subject', domainResponse('unrelated.com', expirationEvents('2030-01-01'))],
    ['an invalid calendar date', domainResponse('example.com', expirationEvents('2027-02-30'))],
    [
      'conflicting expiration events',
      domainResponse('example.com', [
        ...expirationEvents('2030-01-01'),
        ...expirationEvents('2020-01-01'),
      ]),
    ],
  ])('treats %s as unavailable evidence', async (_case, payload) => {
    const request = transportRequests([
      jsonResponse({ services: [[['com'], ['https://rdap.example/']]] }),
      jsonResponse(payload),
    ]);

    await expect(
      new NodeRdapDomainClient({ resolver, transport: { request } }).lookup(
        'example.com',
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({ expirationDate: null });
  });

  it.each(['http://127.0.0.1/private', 'https://127.0.0.1/private'])(
    'rejects an unsafe redirect to %s',
    async (location) => {
      const request = transportRequests([redirectResponse(location)]);
      await expect(
        new NodeRdapDomainClient({ resolver, transport: { request } }).lookup(
          'example.com',
          new AbortController().signal,
        ),
      ).rejects.toThrow();
      expect(request).toHaveBeenCalledTimes(1);
    },
  );

  it('enforces the streamed response-size limit before JSON parsing', async () => {
    const request = transportRequests([
      jsonResponse({ services: [[['com'], ['https://rdap.example/']]] }),
      jsonResponse({ padding: 'x'.repeat(1_048_576) }),
    ]);

    await expect(
      new NodeRdapDomainClient({ resolver, transport: { request } }).lookup(
        'example.com',
        new AbortController().signal,
      ),
    ).rejects.toBeInstanceOf(EncodedBodyTooLargeError);
  });

  it('does not cache a malformed bootstrap as unsupported coverage', async () => {
    const request = transportRequests([jsonResponse({ services: [] })]);
    const error = await new NodeRdapDomainClient({ resolver, transport: { request } })
      .lookup('example.com', new AbortController().signal)
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(RdapUnsupportedTldError);
  });
});

function transportRequests(responses: HttpTransportResponse[]) {
  return vi.fn<PinnedHttpTransport['request']>(() => {
    const response = responses.shift();
    return response
      ? Promise.resolve(response)
      : Promise.reject(new Error('Unexpected RDAP request.'));
  });
}

function jsonResponse(value: unknown): HttpTransportResponse {
  const body = Buffer.from(JSON.stringify(value));
  return {
    statusCode: 200,
    location: null,
    headers: [],
    captureEncodedBody(limitBytes) {
      return body.byteLength > limitBytes
        ? Promise.reject(new EncodedBodyTooLargeError())
        : Promise.resolve(body);
    },
    discardBody: vi.fn(() => Promise.resolve()),
  };
}

function redirectResponse(location: string): HttpTransportResponse {
  return {
    statusCode: 302,
    location,
    headers: [],
    captureEncodedBody: vi.fn(() => Promise.resolve(new Uint8Array())),
    discardBody: vi.fn(() => Promise.resolve()),
  };
}

function domainResponse(ldhName: string, events: unknown[]) {
  return { objectClassName: 'domain', ldhName, events };
}

function expirationEvents(date: string) {
  return [{ eventAction: 'expiration', eventDate: `${date}T00:00:00Z` }];
}
