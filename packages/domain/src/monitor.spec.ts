import { describe, expect, it } from 'vitest';
import {
  createMonitor,
  MONITOR_DEFAULTS,
  MonitorInputError,
  parseHttpMonitorSettings,
} from './monitor.js';

describe('createMonitor', () => {
  it('normalizes input and applies server-owned defaults', () => {
    expect(createMonitor({ name: '  API  ', url: 'https://example.com/health' })).toEqual({
      name: 'API',
      url: 'https://example.com/health',
      ...MONITOR_DEFAULTS,
      requestHeaders: [],
      locations: ['local'],
    });
  });

  it('normalizes request headers and rejects retained secrets during creation', () => {
    expect(
      createMonitor({
        name: 'API',
        url: 'https://example.com',
        requestHeaders: [{ name: 'Authorization', sensitive: false, value: 'Bearer secret' }],
      }).requestHeaders,
    ).toEqual([{ name: 'authorization', sensitive: true, value: 'Bearer secret' }]);

    expect(() =>
      createMonitor({
        name: 'API',
        url: 'https://example.com',
        requestHeaders: [{ name: 'Authorization', sensitive: true, retain: true }],
      }),
    ).toThrow(MonitorInputError);
  });

  it.each(['ftp://example.com', 'example.com', 'not a url'])('rejects invalid URL %s', (url) => {
    expect(() => createMonitor({ name: 'API', url })).toThrow(MonitorInputError);
  });

  it('rejects an empty name and URL with field errors', () => {
    try {
      createMonitor({ name: ' ', url: '' });
      expect.unreachable('Expected monitor validation to fail.');
    } catch (error) {
      expect(error).toBeInstanceOf(MonitorInputError);
      expect((error as MonitorInputError).fields).toEqual({
        name: ['Enter a monitor name.'],
        url: ['Enter an HTTP or HTTPS URL.'],
      });
    }
  });

  it('normalizes an exact status policy into a unique deterministic order', () => {
    const monitor = createMonitor({
      name: 'API',
      url: 'https://example.com',
      statusPolicy: { type: 'EXACT', statusCodes: [404, 200, 404, 204] },
    });

    expect(monitor.statusPolicy).toEqual({ type: 'EXACT', statusCodes: [200, 204, 404] });
  });

  it.each([
    { type: 'EXACT', statusCodes: [] },
    { type: 'EXACT', statusCodes: [99] },
    { type: 'EXACT', statusCodes: [600] },
    { type: 'EXACT', statusCodes: [200.5] },
  ])('rejects invalid exact policy $statusCodes', (statusPolicy) => {
    expect(() => createMonitor({ name: 'API', url: 'https://example.com', statusPolicy })).toThrow(
      MonitorInputError,
    );
  });
});

describe('parseHttpMonitorSettings', () => {
  it('accepts the complete strict HTTP settings contract', () => {
    expect(
      parseHttpMonitorSettings({
        url: 'https://api.example.com/health',
        method: 'HEAD',
        timeoutMs: 5_000,
        followRedirects: false,
      }),
    ).toEqual({
      url: 'https://api.example.com/health',
      method: 'HEAD',
      timeoutMs: 5_000,
      followRedirects: false,
    });
  });

  it.each([1_000, 30_000])('accepts timeout boundary %i', (timeoutMs) => {
    expect(
      parseHttpMonitorSettings({
        url: 'https://example.com',
        method: 'GET',
        timeoutMs,
        followRedirects: true,
      }).timeoutMs,
    ).toBe(timeoutMs);
  });

  it.each([999, 30_001, 1_000.5, '5000'])('rejects invalid timeout %s', (timeoutMs) => {
    expect(() =>
      parseHttpMonitorSettings({
        url: 'https://example.com',
        method: 'GET',
        timeoutMs,
        followRedirects: true,
      }),
    ).toThrow(MonitorInputError);
  });

  it.each(['POST', 'get', undefined])('rejects unsupported method %s', (method) => {
    expect(() =>
      parseHttpMonitorSettings({
        url: 'https://example.com',
        method,
        timeoutMs: 5_000,
        followRedirects: true,
      }),
    ).toThrow(MonitorInputError);
  });

  it.each(['false', 0, undefined])('rejects non-boolean followRedirects %s', (followRedirects) => {
    expect(() =>
      parseHttpMonitorSettings({
        url: 'https://example.com',
        method: 'GET',
        timeoutMs: 5_000,
        followRedirects,
      }),
    ).toThrow(MonitorInputError);
  });

  it('rejects missing and additional settings', () => {
    expect(() =>
      parseHttpMonitorSettings({
        url: 'https://example.com',
        method: 'GET',
        timeoutMs: 5_000,
      }),
    ).toThrow(MonitorInputError);
    expect(() =>
      parseHttpMonitorSettings({
        url: 'https://example.com',
        method: 'GET',
        timeoutMs: 5_000,
        followRedirects: true,
        statusPolicy: { type: 'ANY_2XX' },
      }),
    ).toThrow(MonitorInputError);
  });
});
