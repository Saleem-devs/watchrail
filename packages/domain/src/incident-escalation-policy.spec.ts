import { describe, expect, it } from 'vitest';
import {
  IncidentEscalationPolicyInputError,
  parseIncidentEscalationPolicy,
} from './incident-escalation-policy.js';

describe('incident escalation policy', () => {
  it('accepts a disabled or bounded routed schedule', () => {
    expect(parseIncidentEscalationPolicy({ steps: [] })).toEqual({ steps: [] });
    expect(
      parseIncidentEscalationPolicy({
        steps: [
          { delayMinutes: 15, channelIds: null },
          { delayMinutes: 60, channelIds: ['AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA'] },
        ],
      }),
    ).toEqual({
      steps: [
        { delayMinutes: 15, channelIds: null },
        { delayMinutes: 60, channelIds: ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'] },
      ],
    });
  });

  it.each([
    undefined,
    { steps: [{ delayMinutes: 4, channelIds: null }] },
    {
      steps: [
        { delayMinutes: 15, channelIds: null },
        { delayMinutes: 15, channelIds: null },
      ],
    },
    { steps: [{ delayMinutes: 15, channelIds: [] }] },
    { steps: [{ delayMinutes: 15.5, channelIds: null }] },
    { steps: [{ delayMinutes: 15, channelIds: ['not-a-uuid'] }] },
    {
      steps: [
        { delayMinutes: 15, channelIds: null },
        { delayMinutes: 60, channelIds: null },
        { delayMinutes: 240, channelIds: null },
        { delayMinutes: 480, channelIds: null },
      ],
    },
  ])('rejects an invalid schedule: %j', (input) => {
    expect(() => parseIncidentEscalationPolicy(input)).toThrow(IncidentEscalationPolicyInputError);
  });
});
