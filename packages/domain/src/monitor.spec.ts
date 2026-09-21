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
});
