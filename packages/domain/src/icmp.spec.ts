import { describe, expect, it } from 'vitest';
import { IcmpMonitorInputError, parseIcmpMonitorSettings } from './icmp.js';

describe('parseIcmpMonitorSettings', () => {
  it('normalizes a complete ICMP configuration', () => {
    expect(parseIcmpMonitorSettings({ host: ' Edge.Example.com ', timeoutMs: 5_000 })).toEqual({
      host: 'edge.example.com',
      timeoutMs: 5_000,
    });
  });

  it('accepts an unwrapped IPv6 target', () => {
    expect(parseIcmpMonitorSettings({ host: '[2001:4860:4860::8888]', timeoutMs: 1_000 })).toEqual({
      host: '2001:4860:4860::8888',
      timeoutMs: 1_000,
    });
  });

  it.each([
    [{ host: 'https://example.com', timeoutMs: 5_000 }, 'host'],
    [{ host: 'example.com/path', timeoutMs: 5_000 }, 'host'],
    [{ host: 'example.com', timeoutMs: 999 }, 'timeoutMs'],
  ])('rejects an invalid ICMP field', (input, field) => {
    expect(() => parseIcmpMonitorSettings(input)).toThrow(IcmpMonitorInputError);
    try {
      parseIcmpMonitorSettings(input);
    } catch (error) {
      expect((error as IcmpMonitorInputError).fields).toHaveProperty(field);
    }
  });
});
