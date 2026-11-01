import { describe, expect, it } from 'vitest';
import { DnsMonitorInputError, parseDnsMonitorSettings } from './dns.js';

describe('parseDnsMonitorSettings', () => {
  it('normalizes a complete DNS configuration', () => {
    expect(
      parseDnsMonitorSettings({
        name: ' API.Example.com. ',
        recordType: 'CNAME',
        expectedValues: [' Origin.Example.com. ', 'origin.example.com'],
        timeoutMs: 5_000,
      }),
    ).toEqual({
      name: 'api.example.com',
      recordType: 'CNAME',
      expectedValues: ['origin.example.com'],
      timeoutMs: 5_000,
    });
  });

  it('accepts an empty expected-value list for existence checks', () => {
    expect(
      parseDnsMonitorSettings({
        name: '_status.example.com',
        recordType: 'TXT',
        expectedValues: [],
        timeoutMs: 1_000,
      }),
    ).toMatchObject({ expectedValues: [] });
  });

  it.each([
    [
      { name: 'https://example.com', recordType: 'A', expectedValues: [], timeoutMs: 10_000 },
      'dnsName',
    ],
    [
      { name: 'example.com', recordType: 'CAA', expectedValues: [], timeoutMs: 10_000 },
      'dnsRecordType',
    ],
    [
      { name: 'example.com', recordType: 'A', expectedValues: [42], timeoutMs: 10_000 },
      'dnsExpectedValues',
    ],
    [{ name: 'example.com', recordType: 'A', expectedValues: [], timeoutMs: 999 }, 'timeoutMs'],
  ])('rejects an invalid protocol-specific field', (input, field) => {
    expect(() => parseDnsMonitorSettings(input)).toThrow(DnsMonitorInputError);
    try {
      parseDnsMonitorSettings(input);
    } catch (error) {
      expect((error as DnsMonitorInputError).fields).toHaveProperty(field);
    }
  });
});
