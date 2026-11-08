import { describe, expect, it } from 'vitest';
import { DomainExpiryInputError, parseDomainExpiryMonitorSettings } from './domain-expiry.js';

describe('domain expiry monitor settings', () => {
  it('normalizes a registered domain', () => {
    expect(
      parseDomainExpiryMonitorSettings({
        domainName: ' EXAMPLE.COM. ',
        warningDays: 30,
        timeoutMs: 10_000,
      }),
    ).toEqual({
      domainName: 'example.com',
      warningDays: 30,
      timeoutMs: 10_000,
    });
  });

  it('rejects URLs, single labels, and invalid thresholds', () => {
    for (const domainName of ['https://example.com', 'localhost', '-bad.example']) {
      expect(() =>
        parseDomainExpiryMonitorSettings({ domainName, warningDays: 0, timeoutMs: 999 }),
      ).toThrow(DomainExpiryInputError);
    }
  });
});
