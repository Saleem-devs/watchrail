import { describe, expect, it } from 'vitest';
import { PublicStatusPageRateLimiter } from './public-status-page-rate-limiter.js';
import { ProbeMachineRateLimiter } from './probe-machine-auth.js';

describe('probe machine rate limiting', () => {
  it('bounds retries and remains isolated from public status-page budgets', () => {
    const machine = new ProbeMachineRateLimiter();
    const publicPages = new PublicStatusPageRateLimiter();

    for (let request = 0; request < 20; request += 1) {
      expect(machine.consume('probe-client')).toEqual({ allowed: true });
    }
    const limited = machine.consume('probe-client');
    expect(limited.allowed).toBe(false);
    if (limited.allowed) throw new Error('Expected the probe client to be rate limited.');
    expect(limited.retryAfterSeconds).toBeGreaterThanOrEqual(1);
    expect(limited.retryAfterSeconds).toBeLessThanOrEqual(60);

    expect(publicPages.consume('public-client')).toEqual({ allowed: true });
  });
});
