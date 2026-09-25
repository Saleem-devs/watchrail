import { describe, expect, it, vi } from 'vitest';
import {
  InvalidHttpTargetError,
  ProhibitedDestinationError,
  resolveSafeHttpTarget,
  type DnsAddress,
  type DnsResolver,
} from './safe-http-target.js';

function resolverReturning(...addresses: DnsAddress[]): DnsResolver {
  return { lookup: vi.fn(() => Promise.resolve(addresses)) };
}

const signal = new AbortController().signal;

describe('resolveSafeHttpTarget', () => {
  it('returns normalized public addresses and the original authority', async () => {
    const resolver = resolverReturning(
      { address: '93.184.216.34', family: 4 },
      { address: '2606:2800:220:1:248:1893:25c8:1946', family: 6 },
    );

    const target = await resolveSafeHttpTarget('https://EXAMPLE.com:8443/health', {
      resolver,
      signal,
    });

    expect(target).toMatchObject({
      hostname: 'example.com',
      port: 8443,
      addresses: [
        { address: '93.184.216.34', family: 4 },
        { address: '2606:2800:220:1:248:1893:25c8:1946', family: 6 },
      ],
    });
    expect(resolver.lookup).toHaveBeenCalledWith('example.com');
  });

  it.each(['127.0.0.1', '10.0.0.8', '169.254.169.254', '172.16.0.1', '192.168.1.1', '224.0.0.1'])(
    'rejects prohibited IPv4 address %s',
    async (address) => {
      await expect(
        resolveSafeHttpTarget('https://example.com', {
          resolver: resolverReturning({ address, family: 4 }),
          signal,
        }),
      ).rejects.toBeInstanceOf(ProhibitedDestinationError);
    },
  );

  it.each(['::1', 'fc00::1', 'fe80::1', 'ff02::1'])(
    'rejects prohibited IPv6 address %s',
    async (address) => {
      await expect(
        resolveSafeHttpTarget('https://example.com', {
          resolver: resolverReturning({ address, family: 6 }),
          signal,
        }),
      ).rejects.toBeInstanceOf(ProhibitedDestinationError);
    },
  );

  it('normalizes IPv4-mapped IPv6 before applying IPv4 policy', async () => {
    await expect(
      resolveSafeHttpTarget('https://example.com', {
        resolver: resolverReturning({ address: '::ffff:7f00:1', family: 6 }),
        signal,
      }),
    ).rejects.toBeInstanceOf(ProhibitedDestinationError);
  });

  it('rejects the entire target when DNS mixes public and prohibited answers', async () => {
    await expect(
      resolveSafeHttpTarget('https://example.com', {
        resolver: resolverReturning(
          { address: '93.184.216.34', family: 4 },
          { address: '127.0.0.1', family: 4 },
        ),
        signal,
      }),
    ).rejects.toBeInstanceOf(ProhibitedDestinationError);
  });

  it('does not perform DNS lookup for an IP literal', async () => {
    const resolver = resolverReturning({ address: '127.0.0.1', family: 4 });

    const target = await resolveSafeHttpTarget('https://93.184.216.34/health', {
      resolver,
      signal,
    });

    expect(target.addresses).toEqual([{ address: '93.184.216.34', family: 4 }]);
    expect(resolver.lookup).not.toHaveBeenCalled();
  });

  it.each(['ftp://example.com', 'https://user:secret@example.com'])(
    'rejects unsupported or credential-bearing target %s',
    async (url) => {
      await expect(resolveSafeHttpTarget(url, { signal })).rejects.toBeInstanceOf(
        InvalidHttpTargetError,
      );
    },
  );

  it('stops waiting for DNS when the attempt signal is aborted', async () => {
    const controller = new AbortController();
    const resolver: DnsResolver = {
      lookup: vi.fn(() => new Promise<readonly DnsAddress[]>(() => undefined)),
    };
    const resolution = resolveSafeHttpTarget('https://example.com', {
      resolver,
      signal: controller.signal,
    });

    controller.abort(new DOMException('deadline', 'AbortError'));

    await expect(resolution).rejects.toMatchObject({ name: 'AbortError' });
  });
});
