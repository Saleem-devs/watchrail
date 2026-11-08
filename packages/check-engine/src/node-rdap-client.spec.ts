import { afterEach, describe, expect, it, vi } from 'vitest';
import { RdapUnsupportedTldError } from './domain-expiry-types.js';
import { NodeRdapDomainClient } from './node-rdap-client.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('NodeRdapDomainClient', () => {
  it('uses the IANA bootstrap service and reads the RDAP expiration event', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({
          services: [[['com'], ['http://insecure.example/', 'https://rdap.example/']]],
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          events: [
            { eventAction: 'registration', eventDate: '2020-01-01T00:00:00Z' },
            { eventAction: 'expiration', eventDate: '2027-01-02T03:04:05Z' },
          ],
        }),
      );
    vi.stubGlobal('fetch', fetchMock);

    const result = await new NodeRdapDomainClient().lookup('example.com', new AbortController().signal);

    expect(result).toEqual({
      expirationDate: new Date('2027-01-02T03:04:05Z'),
      sourceUrl: 'https://rdap.example/domain/example.com',
    });
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      new URL('https://rdap.example/domain/example.com'),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it('rejects a TLD that has no HTTPS RDAP service', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>().mockResolvedValue(
        jsonResponse({ services: [[['invalid'], ['http://insecure.example/']]] }),
      ),
    );

    await expect(
      new NodeRdapDomainClient().lookup('example.invalid', new AbortController().signal),
    ).rejects.toBeInstanceOf(RdapUnsupportedTldError);
  });
});

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}
