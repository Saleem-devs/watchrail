import { describe, expect, it } from 'vitest';
import { parseTcpMonitorSettings, TcpMonitorInputError } from './tcp.js';

describe('parseTcpMonitorSettings', () => {
  it('normalizes a complete TCP configuration', () => {
    expect(
      parseTcpMonitorSettings({ host: ' DB.Example.com ', port: 5432, timeoutMs: 5_000 }),
    ).toEqual({ host: 'db.example.com', port: 5432, timeoutMs: 5_000 });
  });

  it('accepts an unwrapped IPv6 target', () => {
    expect(
      parseTcpMonitorSettings({ host: '[2001:4860:4860::8888]', port: 53, timeoutMs: 1_000 }),
    ).toEqual({ host: '2001:4860:4860::8888', port: 53, timeoutMs: 1_000 });
  });

  it.each([
    [{ host: 'https://example.com', port: 443, timeoutMs: 10_000 }, 'host'],
    [{ host: 'example.com', port: 0, timeoutMs: 10_000 }, 'port'],
    [{ host: 'example.com', port: 443, timeoutMs: 999 }, 'timeoutMs'],
  ])('rejects an invalid protocol-specific field', (input, field) => {
    expect(() => parseTcpMonitorSettings(input)).toThrow(TcpMonitorInputError);
    try {
      parseTcpMonitorSettings(input);
    } catch (error) {
      expect((error as TcpMonitorInputError).fields).toHaveProperty(field);
    }
  });
});
