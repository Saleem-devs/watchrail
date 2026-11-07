import { describe, expect, it } from 'vitest';
import {
  IncidentReminderPolicyInputError,
  parseIncidentReminderPolicy,
} from './incident-reminder-policy.js';

describe('incident reminder policy', () => {
  it('accepts a disabled or bounded increasing schedule', () => {
    expect(parseIncidentReminderPolicy({ delaysMinutes: [] })).toEqual({ delaysMinutes: [] });
    expect(parseIncidentReminderPolicy({ delaysMinutes: [15, 60, 240] })).toEqual({
      delaysMinutes: [15, 60, 240],
    });
  });

  it.each([
    undefined,
    { delaysMinutes: [4] },
    { delaysMinutes: [15, 15] },
    { delaysMinutes: [60, 15] },
    { delaysMinutes: [15, 60, 240, 480] },
    { delaysMinutes: [15.5] },
    { delaysMinutes: [10_081] },
  ])('rejects an invalid schedule: %j', (input) => {
    expect(() => parseIncidentReminderPolicy(input)).toThrow(IncidentReminderPolicyInputError);
  });
});
