import { describe, expect, it } from 'vitest';
import {
  STATUS_PAGE_CACHE_POLICY,
  StatusPageInputError,
  derivePublicComponentStatus,
  derivePublicPageStatus,
  parseStatusPage,
  publicStatusPageVisibility,
  resolvedIncidentIsPublic,
} from './status-page.js';

describe('status-page domain contract', () => {
  it.each([
    ['ENABLED', 'UP', 'OPERATIONAL'],
    ['ENABLED', 'DEGRADED', 'PARTIAL_OUTAGE'],
    ['ENABLED', 'DOWN', 'MAJOR_OUTAGE'],
    ['ENABLED', 'UNKNOWN', 'MONITORING_IMPAIRED'],
    ['PAUSED', 'UP', 'MONITORING_IMPAIRED'],
    ['ARCHIVED', 'DOWN', 'MONITORING_IMPAIRED'],
  ] as const)('%s / %s becomes %s', (lifecycleState, aggregateState, expected) => {
    expect(derivePublicComponentStatus({ lifecycleState, aggregateState })).toBe(expected);
  });

  it.each([
    [[], 'MONITORING_IMPAIRED'],
    [['OPERATIONAL'], 'OPERATIONAL'],
    [['PARTIAL_OUTAGE'], 'PARTIAL_OUTAGE'],
    [['MAJOR_OUTAGE'], 'MAJOR_OUTAGE'],
    [['MAJOR_OUTAGE', 'MAJOR_OUTAGE'], 'MAJOR_OUTAGE'],
    [['OPERATIONAL', 'MAJOR_OUTAGE'], 'PARTIAL_OUTAGE'],
    [['OPERATIONAL', 'PARTIAL_OUTAGE'], 'PARTIAL_OUTAGE'],
    [['PARTIAL_OUTAGE', 'MAJOR_OUTAGE'], 'PARTIAL_OUTAGE'],
    [['MONITORING_IMPAIRED', 'MAJOR_OUTAGE'], 'MONITORING_IMPAIRED'],
    [['OPERATIONAL', 'MONITORING_IMPAIRED'], 'MONITORING_IMPAIRED'],
    [['PARTIAL_OUTAGE', 'MONITORING_IMPAIRED'], 'MONITORING_IMPAIRED'],
  ] as const)('aggregates %j as %s', (states, expected) => {
    expect(derivePublicPageStatus(states)).toBe(expected);
  });

  it('parses and orders a strict private configuration', () => {
    expect(
      parseStatusPage({
        organizationId: 'org-1',
        name: 'Watchrail Status',
        slug: 'watchrail-status',
        published: true,
        components: [
          { id: 'component-2', displayName: 'API', monitorId: 'monitor-2', position: 1 },
          { id: 'component-1', displayName: 'Web', monitorId: 'monitor-1', position: 0 },
        ],
      }).components.map(({ id }) => id),
    ).toEqual(['component-1', 'component-2']);
  });

  it.each(['Watchrail', 'watch_rail', '-watchrail', 'watchrail-', 'watch--rail', 'ab'])(
    'rejects invalid slug %s',
    (slug) => {
      expect(() =>
        parseStatusPage({
          organizationId: 'org-1',
          name: 'Status',
          slug,
          published: false,
          components: [],
        }),
      ).toThrow(StatusPageInputError);
    },
  );

  it('rejects duplicate component identity, monitor membership, and position', () => {
    expect(() =>
      parseStatusPage({
        organizationId: 'org-1',
        name: 'Status',
        slug: 'watchrail',
        published: false,
        components: [
          { id: 'same', displayName: 'API', monitorId: 'same-monitor', position: 0 },
          { id: 'same', displayName: 'Web', monitorId: 'same-monitor', position: 0 },
        ],
      }),
    ).toThrow(StatusPageInputError);
  });

  it('makes unpublished pages indistinguishable from unknown slugs', () => {
    expect(publicStatusPageVisibility(false)).toBe('NOT_FOUND');
    expect(publicStatusPageVisibility(true)).toBe('PUBLIC');
  });

  it('publishes resolved incidents for 90 days, inclusively', () => {
    const cutoff = new Date('2026-10-07T12:00:00.000Z');
    expect(resolvedIncidentIsPublic(new Date('2026-07-09T12:00:00.000Z'), cutoff)).toBe(true);
    expect(resolvedIncidentIsPublic(new Date('2026-07-09T11:59:59.999Z'), cutoff)).toBe(false);
    expect(resolvedIncidentIsPublic(new Date('2026-10-07T12:00:00.001Z'), cutoff)).toBe(false);
  });

  it('locks the public cache freshness guarantee', () => {
    expect(STATUS_PAGE_CACHE_POLICY).toEqual({
      maxAgeSeconds: 30,
      staleWhileRevalidateSeconds: 30,
      freshnessTargetSeconds: 60,
    });
  });
});
