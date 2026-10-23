import { describe, expect, it } from 'vitest';
import { summarizeMonitors } from './monitor-summary';

describe('summarizeMonitors', () => {
  it('represents an empty workspace without inventing healthy monitors', () => {
    expect(summarizeMonitors([])).toEqual({
      total: 0,
      operational: 0,
      needsAttention: 0,
      paused: 0,
      pending: 0,
      openIncidents: 0,
    });
  });

  it('separates operational, degraded, unavailable and unknown evidence', () => {
    expect(
      summarizeMonitors([
        {
          lifecycleState: 'ENABLED',
          currentCheck: { availability: 'AVAILABLE' },
          incidentState: { currentIncident: null },
        },
        {
          lifecycleState: 'ENABLED',
          currentCheck: { availability: 'AVAILABLE', aggregateOutcome: 'DEGRADED' },
          incidentState: { currentIncident: { id: 'incident-a' } },
        },
        {
          lifecycleState: 'ENABLED',
          currentCheck: { availability: 'UNAVAILABLE', aggregateOutcome: 'DOWN' },
        },
        {
          lifecycleState: 'ENABLED',
          currentCheck: { availability: 'UNKNOWN', aggregateOutcome: 'UNKNOWN' },
        },
        { lifecycleState: 'ENABLED', currentCheck: null },
        {
          lifecycleState: 'ENABLED',
          currentCheck: { availability: 'AVAILABLE', aggregateOutcome: 'UP' },
        },
      ]),
    ).toEqual({
      total: 6,
      operational: 2,
      needsAttention: 2,
      paused: 0,
      pending: 2,
      openIncidents: 1,
    });
  });

  it('keeps current incidents independent from the last observed health', () => {
    expect(
      summarizeMonitors([
        {
          lifecycleState: 'ENABLED',
          currentCheck: { availability: 'AVAILABLE' },
          incidentState: { currentIncident: { id: 'incident-a' } },
        },
      ]),
    ).toMatchObject({ operational: 1, needsAttention: 0, openIncidents: 1 });
  });

  it('keeps a paused monitor separate when its retained historical check passed', () => {
    expect(
      summarizeMonitors([
        {
          lifecycleState: 'PAUSED',
          currentCheck: { availability: 'AVAILABLE', aggregateOutcome: 'UP' },
        },
      ]),
    ).toEqual({
      total: 1,
      operational: 0,
      needsAttention: 0,
      paused: 1,
      pending: 0,
      openIncidents: 0,
    });
  });
});
