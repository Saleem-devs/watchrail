import { describe, expect, it } from 'vitest';
import {
  createMonitor,
  MONITOR_DEFAULTS,
  MonitorInputError,
  parseHttpMonitorSettings,
  parseMonitorLifecycleSettings,
  parseMonitorScheduleSettings,
} from './monitor.js';

describe('createMonitor', () => {
  it('normalizes input and applies server-owned defaults', () => {
    expect(createMonitor({ name: '  API  ', url: 'https://example.com/health' })).toEqual({
      name: 'API',
      url: 'https://example.com/health',
      ...MONITOR_DEFAULTS,
      requestHeaders: [],
      assertions: { headers: [], textBody: [], jsonBody: [] },
      locations: ['local'],
    });
  });

  it('accepts an optional creation interval and rejects invalid values', () => {
    expect(
      createMonitor({ name: 'API', url: 'https://example.com', intervalSeconds: 300 })
        .intervalSeconds,
    ).toBe(300);
    expect(() =>
      createMonitor({ name: 'API', url: 'https://example.com', intervalSeconds: '300' }),
    ).toThrow(MonitorInputError);
  });

  it('normalizes assertions and rejects retained assertion secrets during creation', () => {
    expect(
      createMonitor({
        name: 'API',
        url: 'https://example.com',
        assertions: {
          headers: [{ name: 'x-state', operator: 'exists' }],
          textBody: [],
          jsonBody: [],
        },
      }).assertions,
    ).toEqual({
      headers: [{ name: 'x-state', operator: 'exists' }],
      textBody: [],
      jsonBody: [],
    });

    expect(() =>
      createMonitor({
        name: 'API',
        url: 'https://example.com',
        assertions: {
          headers: [],
          textBody: [{ operator: 'equals', target: { sensitive: true, retain: true } }],
          jsonBody: [],
        },
      }),
    ).toThrow(MonitorInputError);
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

describe('monitor scheduling settings', () => {
  it.each([60, 86_400])('accepts interval boundary %i', (intervalSeconds) => {
    expect(parseMonitorScheduleSettings({ intervalSeconds })).toEqual({ intervalSeconds });
  });

  it.each([undefined, '60', 59, 86_401, 60.5, 0, -1])(
    'rejects invalid interval %s',
    (intervalSeconds) => {
      expect(() => parseMonitorScheduleSettings({ intervalSeconds })).toThrow(MonitorInputError);
    },
  );

  it('rejects missing and additional schedule properties', () => {
    expect(() => parseMonitorScheduleSettings({})).toThrow(MonitorInputError);
    expect(() => parseMonitorScheduleSettings({ intervalSeconds: 60, nextCheckAt: null })).toThrow(
      MonitorInputError,
    );
  });

  it.each(['ENABLED', 'PAUSED', 'ARCHIVED'] as const)(
    'accepts lifecycle state %s',
    (lifecycleState) => {
      expect(parseMonitorLifecycleSettings({ lifecycleState })).toEqual({ lifecycleState });
    },
  );

  it.each(['enabled', 'DELETED', undefined, null])(
    'rejects invalid lifecycle state %s',
    (lifecycleState) => {
      expect(() => parseMonitorLifecycleSettings({ lifecycleState })).toThrow(MonitorInputError);
    },
  );
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
