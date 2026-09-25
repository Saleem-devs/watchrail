import { describe, expect, it } from 'vitest';
import { createMonitor, MONITOR_DEFAULTS, MonitorInputError } from './monitor.js';

describe('createMonitor', () => {
  it('normalizes input and applies server-owned defaults', () => {
    expect(createMonitor({ name: '  API  ', url: 'https://example.com/health' })).toEqual({
      name: 'API',
      url: 'https://example.com/health',
      ...MONITOR_DEFAULTS,
      locations: ['local'],
    });
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
