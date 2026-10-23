import { describe, expect, it } from 'vitest';
import { summarizeMonitors } from './monitor-summary';

describe('summarizeMonitors', () => {
  it('represents an empty workspace without inventing healthy monitors', () => {
    expect(summarizeMonitors([])).toEqual({
      total: 0,
      operational: 0,
      needsAttention: 0,
      pending: 0,
      openIncidents: 0,
    });
  });

  it('separates operational, degraded, unavailable and unknown evidence', () => {
    expect(
      summarizeMonitors([
        { currentCheck: { availability: 'AVAILABLE' }, incidentState: { currentIncident: null } },
        {
          currentCheck: { availability: 'AVAILABLE', aggregateOutcome: 'DEGRADED' },
          incidentState: { currentIncident: { id: 'incident-a' } },
        },
        { currentCheck: { availability: 'UNAVAILABLE', aggregateOutcome: 'DOWN' } },
        { currentCheck: { availability: 'UNKNOWN', aggregateOutcome: 'UNKNOWN' } },
        { currentCheck: null },
        { currentCheck: { availability: 'AVAILABLE', aggregateOutcome: 'UP' } },
      ]),
    ).toEqual({
      total: 6,
      operational: 2,
      needsAttention: 2,
      pending: 2,
      openIncidents: 1,
    });
  });

  it('keeps current incidents independent from the last observed health', () => {
    expect(
      summarizeMonitors([
        {
          currentCheck: { availability: 'AVAILABLE' },
          incidentState: { currentIncident: { id: 'incident-a' } },
        },
      ]),
    ).toMatchObject({ operational: 1, needsAttention: 0, openIncidents: 1 });
  });
});
