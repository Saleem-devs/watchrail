import { describe, expect, it } from 'vitest';
import {
  availabilityStateForLifecycle,
  classifyAvailabilityObservation,
  deriveAvailabilityMetrics,
  intersectMeasurementWindow,
  isRoundNewer,
  nextUtcDayStart,
  utcDayStart,
} from './availability.js';

describe('availability semantics', () => {
  it.each([
    ['PASS', 'COMPLETED', 'PASS', 'AVAILABLE'],
    ['FAIL', 'UNEXPECTED_STATUS', 'PASS', 'UNAVAILABLE'],
    ['PASS', 'COMPLETED', 'FAIL', 'UNAVAILABLE'],
    ['UNKNOWN', 'NAME_NOT_FOUND', 'PASS', 'UNAVAILABLE'],
    ['UNKNOWN', 'CERTIFICATE_UNTRUSTED', 'PASS', 'UNAVAILABLE'],
    ['UNKNOWN', 'INTERNAL_ERROR', 'PASS', 'UNKNOWN'],
    ['UNKNOWN', 'PROHIBITED_DESTINATION', 'PASS', 'UNKNOWN'],
    ['PASS', 'COMPLETED', 'NOT_EVALUATED', 'UNKNOWN'],
  ] as const)(
    'maps scheduled observations to %s',
    (outcome, reason, assertionOutcome, expected) => {
      expect(
        classifyAvailabilityObservation({
          trigger: 'SCHEDULED',
          outcome,
          reason,
          assertionOutcome,
        }),
      ).toBe(expected);
    },
  );

  it('ignores manual observations', () => {
    expect(
      classifyAvailabilityObservation({
        trigger: 'MANUAL',
        outcome: 'FAIL',
        reason: 'UNEXPECTED_STATUS',
        assertionOutcome: 'FAIL',
      }),
    ).toBeNull();
  });

  it('uses unknown when enabled and excluded when paused or archived', () => {
    expect(availabilityStateForLifecycle('ENABLED')).toBe('UNKNOWN');
    expect(availabilityStateForLifecycle('PAUSED')).toBe('EXCLUDED');
    expect(availabilityStateForLifecycle('ARCHIVED')).toBe('EXCLUDED');
  });

  it('uses a monotonic created-at and round-ID key', () => {
    const watermark = {
      createdAt: new Date('2026-10-03T12:00:00Z'),
      roundId: '22222222-2222-4222-8222-222222222222',
    };
    expect(
      isRoundNewer({ ...watermark, roundId: '33333333-3333-4333-8333-333333333333' }, watermark),
    ).toBe(true);
    expect(
      isRoundNewer({ ...watermark, roundId: '11111111-1111-4111-8111-111111111111' }, watermark),
    ).toBe(false);
  });

  it('derives uptime from known time and coverage from eligible time', () => {
    expect(
      deriveAvailabilityMetrics({ availableMs: 22, unavailableMs: 1, unknownMs: 1, excludedMs: 0 }),
    ).toEqual({
      uptimePercent: (22 / 23) * 100,
      coveragePercent: (23 / 24) * 100,
      knownMs: 23,
      eligibleMs: 24,
    });
    expect(
      deriveAvailabilityMetrics({ availableMs: 0, unavailableMs: 0, unknownMs: 1, excludedMs: 0 }),
    ).toMatchObject({ uptimePercent: null, coveragePercent: 0 });
    expect(
      deriveAvailabilityMetrics({ availableMs: 0, unavailableMs: 0, unknownMs: 0, excludedMs: 1 }),
    ).toMatchObject({ uptimePercent: null, coveragePercent: null });
  });

  it('uses UTC day boundaries', () => {
    const value = new Date('2026-03-29T23:30:00-07:00');
    expect(utcDayStart(value).toISOString()).toBe('2026-03-30T00:00:00.000Z');
    expect(nextUtcDayStart(value).toISOString()).toBe('2026-03-31T00:00:00.000Z');
  });

  it('excludes pre-tracking time from measurement', () => {
    expect(
      intersectMeasurementWindow(
        new Date('2026-09-01Z'),
        new Date('2026-10-01Z'),
        new Date('2026-09-26Z'),
      ),
    ).toEqual({
      start: new Date('2026-09-26Z'),
      end: new Date('2026-10-01Z'),
    });
    expect(
      intersectMeasurementWindow(
        new Date('2026-09-01Z'),
        new Date('2026-09-02Z'),
        new Date('2026-09-03Z'),
      ),
    ).toBeNull();
  });
});
