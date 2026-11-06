import { describe, expect, it } from 'vitest';
import {
  maintenanceOccurrenceAt,
  maintenanceOccurrencesBetween,
  mergeMaintenanceEffects,
  parseMaintenanceWindowInput,
} from './maintenance-window.js';

describe('maintenance windows', () => {
  it('normalizes one-time input and requires an explicit useful policy', () => {
    expect(
      parseMaintenanceWindowInput({
        name: ' Database upgrade ',
        schedule: {
          type: 'ONE_TIME',
          startsAt: '2026-11-07T01:00:00+01:00',
          endsAt: '2026-11-07T03:00:00+01:00',
        },
        target: { type: 'PROJECT' },
        effects: {
          suppressNotifications: true,
          suppressIncidentCreation: true,
          excludeFromUptime: true,
          publishToStatusPage: true,
        },
      }),
    ).toEqual({
      name: 'Database upgrade',
      schedule: {
        type: 'ONE_TIME',
        startsAt: '2026-11-07T00:00:00.000Z',
        endsAt: '2026-11-07T02:00:00.000Z',
      },
      target: { type: 'PROJECT' },
      effects: {
        suppressNotifications: true,
        suppressIncidentCreation: true,
        excludeFromUptime: true,
        publishToStatusPage: true,
      },
    });
  });

  it('evaluates recurring schedules in their IANA time zone across daylight-saving changes', () => {
    const schedule = {
      type: 'RECURRING' as const,
      timezone: 'Europe/London',
      localTime: '02:30',
      daysOfWeek: [0],
      durationMinutes: 90,
      startsOn: '2026-03-01',
      endsOn: '2026-11-30',
    };
    expect(maintenanceOccurrenceAt(schedule, new Date('2026-03-22T03:00:00.000Z'))).toMatchObject({
      startsAt: new Date('2026-03-22T02:30:00.000Z'),
      endsAt: new Date('2026-03-22T04:00:00.000Z'),
    });
    expect(maintenanceOccurrenceAt(schedule, new Date('2026-03-29T02:00:00.000Z'))).toMatchObject({
      startsAt: new Date('2026-03-29T01:30:00.000Z'),
      endsAt: new Date('2026-03-29T03:00:00.000Z'),
    });
  });

  it('returns every overlapping recurring occurrence for availability accounting', () => {
    const occurrences = maintenanceOccurrencesBetween(
      {
        type: 'RECURRING',
        timezone: 'Africa/Lagos',
        localTime: '23:00',
        daysOfWeek: [1, 3],
        durationMinutes: 120,
        startsOn: '2026-11-01',
        endsOn: null,
      },
      new Date('2026-11-02T21:30:00.000Z'),
      new Date('2026-11-05T00:30:00.000Z'),
    );
    expect(occurrences).toEqual([
      {
        startsAt: new Date('2026-11-02T22:00:00.000Z'),
        endsAt: new Date('2026-11-03T00:00:00.000Z'),
      },
      {
        startsAt: new Date('2026-11-04T22:00:00.000Z'),
        endsAt: new Date('2026-11-05T00:00:00.000Z'),
      },
    ]);
  });

  it('unions overlapping policies instead of depending on window order', () => {
    expect(
      mergeMaintenanceEffects([
        {
          suppressNotifications: true,
          suppressIncidentCreation: false,
          excludeFromUptime: false,
          publishToStatusPage: false,
        },
        {
          suppressNotifications: false,
          suppressIncidentCreation: true,
          excludeFromUptime: true,
          publishToStatusPage: true,
        },
      ]),
    ).toEqual({
      suppressNotifications: true,
      suppressIncidentCreation: true,
      excludeFromUptime: true,
      publishToStatusPage: true,
    });
  });
});
