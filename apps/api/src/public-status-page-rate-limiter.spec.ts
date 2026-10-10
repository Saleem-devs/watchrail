import { describe, expect, it } from 'vitest';
import {
  PublicStatusPageRateLimiter,
  type PublicStatusPageRateLimitOptions,
} from './public-status-page-rate-limiter.js';

describe('PublicStatusPageRateLimiter', () => {
  it('allows a normal burst, throttles excess, and refills', () => {
    let now = 0;
    const limiter = new PublicStatusPageRateLimiter(options(), () => now);
    expect(limiter.consume('client')).toEqual({ allowed: true });
    expect(limiter.consume('client')).toEqual({ allowed: true });
    expect(limiter.consume('client')).toEqual({ allowed: false, retryAfterSeconds: 1 });
    now = 1_000;
    expect(limiter.consume('client')).toEqual({ allowed: true });
  });

  it('enforces global capacity independently', () => {
    const limiter = new PublicStatusPageRateLimiter(
      options({ clientCapacity: 10, globalCapacity: 2 }),
      () => 0,
    );
    expect(limiter.consume('a').allowed).toBe(true);
    expect(limiter.consume('b').allowed).toBe(true);
    expect(limiter.consume('c')).toEqual({ allowed: false, retryAfterSeconds: 1 });
  });

  it('bounds tracked identities and shares one overflow bucket', () => {
    const limiter = new PublicStatusPageRateLimiter(
      options({ clientCapacity: 1, globalCapacity: 100, maximumTrackedClients: 2 }),
      () => 0,
    );
    expect(limiter.consume('a').allowed).toBe(true);
    expect(limiter.consume('b').allowed).toBe(true);
    expect(limiter.consume('overflow-a').allowed).toBe(true);
    expect(limiter.consume('overflow-b')).toEqual({ allowed: false, retryAfterSeconds: 1 });
    expect(limiter.trackedClientCount).toBe(2);
  });

  it('expires idle client state without exceeding the hard maximum', () => {
    let now = 0;
    const limiter = new PublicStatusPageRateLimiter(
      options({ maximumTrackedClients: 1, clientTtlMs: 1_000 }),
      () => now,
    );
    limiter.consume('old');
    expect(limiter.trackedClientCount).toBe(1);
    now = 1_000;
    expect(limiter.consume('new').allowed).toBe(true);
    expect(limiter.trackedClientCount).toBe(1);
    expect(limiter.consume('old').allowed).toBe(true);
    expect(limiter.trackedClientCount).toBe(1);
  });
});

function options(
  overrides: Partial<PublicStatusPageRateLimitOptions> = {},
): PublicStatusPageRateLimitOptions {
  return {
    clientCapacity: 2,
    clientRefillPerSecond: 1,
    globalCapacity: 100,
    globalRefillPerSecond: 1,
    clientTtlMs: 10_000,
    maximumTrackedClients: 10,
    maximumRetryAfterSeconds: 10,
    ...overrides,
  };
}
