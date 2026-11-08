import { describe, expect, it, vi } from 'vitest';
import { executeDomainExpiryCheck } from './domain-expiry-check.js';
import { RdapUnsupportedTldError, type RdapDomainClient } from './domain-expiry-types.js';

const checkedAt = new Date('2026-11-08T00:00:00.000Z');

function clock() {
  let monotonic = 0;
  return {
    now: () => checkedAt,
    monotonicNow: () => (monotonic += 5),
  };
}

describe('executeDomainExpiryCheck', () => {
  it.each([
    ['DOMAIN_HEALTHY', 'PASS', '2027-02-08T00:00:00.000Z', 92],
    ['DOMAIN_EXPIRING', 'FAIL', '2026-11-20T00:00:00.000Z', 12],
    ['DOMAIN_EXPIRED', 'FAIL', '2026-11-07T00:00:00.000Z', -1],
  ] as const)('classifies %s with bounded expiry evidence', async (reason, outcome, date, days) => {
    const client: RdapDomainClient = {
      lookup: vi
        .fn()
        .mockResolvedValue({ expirationDate: new Date(date), sourceUrl: 'https://rdap.test/' }),
    };
    const result = await executeDomainExpiryCheck(
      { domainName: 'example.com', warningDays: 30, timeoutMs: 1_000 },
      { client, clock: clock() },
    );
    expect(result).toMatchObject({
      outcome,
      stage: 'DOMAIN',
      reason,
      evidence: { domainName: 'example.com', daysRemaining: days, warningDays: 30 },
    });
    expect(result.evidence).not.toHaveProperty('sourceUrl');
  });

  it('does not turn unsupported coverage into a false incident signal', async () => {
    const client: RdapDomainClient = {
      lookup: vi.fn().mockRejectedValue(new RdapUnsupportedTldError()),
    };
    await expect(
      executeDomainExpiryCheck(
        { domainName: 'example.invalid', warningDays: 30, timeoutMs: 1_000 },
        { client, clock: clock() },
      ),
    ).resolves.toMatchObject({ outcome: 'UNKNOWN', reason: 'RDAP_UNSUPPORTED_TLD' });
  });

  it('treats a missing expiration event as indeterminate', async () => {
    const client: RdapDomainClient = {
      lookup: vi.fn().mockResolvedValue({ expirationDate: null, sourceUrl: 'https://rdap.test/' }),
    };
    await expect(
      executeDomainExpiryCheck(
        { domainName: 'example.com', warningDays: 30, timeoutMs: 1_000 },
        { client, clock: clock() },
      ),
    ).resolves.toMatchObject({ outcome: 'UNKNOWN', reason: 'DOMAIN_EXPIRATION_UNAVAILABLE' });
  });

  it('finishes at the configured deadline when the RDAP client ignores abort', async () => {
    vi.useFakeTimers();
    try {
      const client: RdapDomainClient = {
        lookup: vi.fn().mockReturnValue(new Promise(() => undefined)),
      };
      const resultPromise = executeDomainExpiryCheck(
        { domainName: 'example.com', warningDays: 30, timeoutMs: 1_000 },
        { client, clock: clock() },
      );

      await vi.advanceTimersByTimeAsync(1_000);

      await expect(resultPromise).resolves.toMatchObject({
        outcome: 'UNKNOWN',
        reason: 'RDAP_UNAVAILABLE',
      });
    } finally {
      vi.useRealTimers();
    }
  });
});
