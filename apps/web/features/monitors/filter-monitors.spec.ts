import { describe, expect, it } from 'vitest';
import { filterMonitors } from './filter-monitors';
import type { Monitor } from './types';

function monitor(
  name: string,
  state: Monitor['lifecycleState'],
  availability: 'AVAILABLE' | 'UNAVAILABLE' | 'UNKNOWN' | null,
  outcome: 'UP' | 'DEGRADED' | 'DOWN' | 'UNKNOWN' | null = null,
): Monitor {
  return {
    id: name,
    name,
    url: `https://${name.toLowerCase().replaceAll(' ', '-')}.example.com/health`,
    method: 'GET',
    lifecycleState: state,
    timeoutMs: 10_000,
    followRedirects: true,
    statusPolicy: { type: 'ANY_2XX' },
    locations: ['local'],
    createdAt: '2026-01-01T00:00:00Z',
    currentCheck: availability
      ? {
          kind: 'SINGLE_LOCATION',
          availability,
          aggregateOutcome: outcome,
          roundId: name,
          checkedAt: '2026-01-01T00:00:00Z',
          trigger: 'SCHEDULED',
          responseTimeMs: 50,
          coverage: null,
          reachability: null,
        }
      : null,
    incidentState: { failureStreak: null, currentIncident: null },
    uptime: { uptimePercent: null, coveragePercent: null },
  };
}

describe('filterMonitors', () => {
  const monitors = [
    monitor('Production API', 'ENABLED', 'AVAILABLE'),
    monitor('Staging API', 'ENABLED', 'UNAVAILABLE'),
    monitor('Edge Region', 'ENABLED', 'AVAILABLE', 'DEGRADED'),
    monitor('Legacy API', 'PAUSED', 'AVAILABLE'),
    monitor('No Checks', 'ENABLED', null),
  ];

  it('searches by name or URL case-insensitively without mutating source data', () => {
    expect(filterMonitors(monitors, ' API ', 'all').map((m) => m.name)).toEqual([
      'Production API', 'Staging API', 'Legacy API',
    ]);
    expect(filterMonitors(monitors, 'edge-region.example.com', 'all').map((m) => m.name)).toEqual(['Edge Region']);
    expect(monitors).toHaveLength(5);
  });

  it('shares lifecycle-aware health classification with the overview', () => {
    expect(filterMonitors(monitors, '', 'operational').map((m) => m.name)).toEqual(['Production API']);
    expect(filterMonitors(monitors, '', 'attention').map((m) => m.name)).toEqual(['Staging API', 'Edge Region']);
    expect(filterMonitors(monitors, '', 'paused').map((m) => m.name)).toEqual(['Legacy API']);
    expect(filterMonitors(monitors, '', 'pending').map((m) => m.name)).toEqual(['No Checks']);
  });

  it('combines query and filter and returns empty when nothing matches', () => {
    expect(filterMonitors(monitors, 'api', 'paused').map((m) => m.name)).toEqual(['Legacy API']);
    expect(filterMonitors(monitors, 'staging', 'operational')).toEqual([]);
  });
});
