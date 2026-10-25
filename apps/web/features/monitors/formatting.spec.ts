import { describe, expect, it } from 'vitest';
import { monitorStatus } from './formatting';
import type { CurrentCheck } from './types';

const checkedAt = '2026-10-25T12:00:00.000Z';

function check(
  availability: CurrentCheck['availability'],
  aggregateOutcome?: CurrentCheck['aggregateOutcome'],
): CurrentCheck {
  return {
    availability,
    aggregateOutcome,
    responseTimeMs: null,
    checkedAt,
    roundId: 'round-1',
    trigger: 'SCHEDULED',
  } as CurrentCheck;
}

describe('monitorStatus', () => {
  it('keeps paused monitors neutral even when historical evidence passed', () => {
    expect(monitorStatus('PAUSED', check('AVAILABLE', 'UP'))).toBe('PAUSED');
  });

  it('preserves every authoritative aggregate outcome', () => {
    expect(monitorStatus('ENABLED', check('AVAILABLE', 'UP'))).toBe('UP');
    expect(monitorStatus('ENABLED', check('AVAILABLE', 'DEGRADED'))).toBe('DEGRADED');
    expect(monitorStatus('ENABLED', check('UNAVAILABLE', 'DOWN'))).toBe('DOWN');
    expect(monitorStatus('ENABLED', check('UNKNOWN', 'UNKNOWN'))).toBe('UNKNOWN');
  });

  it('maps single-location availability without inventing evidence', () => {
    expect(monitorStatus('ENABLED', check('AVAILABLE'))).toBe('UP');
    expect(monitorStatus('ENABLED', check('UNAVAILABLE'))).toBe('DOWN');
    expect(monitorStatus('ENABLED', null)).toBe('UNKNOWN');
  });
});
