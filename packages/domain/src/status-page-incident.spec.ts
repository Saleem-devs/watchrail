import { describe, expect, it } from 'vitest';
import {
  StatusPageIncidentInputError,
  canTransitionStatusPageIncident,
  parseStatusPageIncidentCreate,
  parseStatusPageIncidentUpdate,
} from './status-page-incident.js';

describe('status-page incident contract', () => {
  it('parses a literal customer update and affected component set', () => {
    expect(
      parseStatusPageIncidentCreate({
        title: 'Checkout is unavailable',
        impact: 'DOWN',
        message: 'We are investigating failed checkout requests.',
        componentIds: ['component-a', 'component-b'],
      }),
    ).toEqual({
      title: 'Checkout is unavailable',
      impact: 'DOWN',
      message: 'We are investigating failed checkout requests.',
      componentIds: ['component-a', 'component-b'],
    });
  });

  it('rejects empty, duplicate, and unsupported input', () => {
    expect(() =>
      parseStatusPageIncidentCreate({
        title: 'Incident',
        impact: 'UNKNOWN',
        message: '',
        componentIds: ['same', 'same'],
      }),
    ).toThrow(StatusPageIncidentInputError);
    expect(() => parseStatusPageIncidentUpdate({ state: 'INVESTIGATING', message: '' })).toThrow(
      StatusPageIncidentInputError,
    );
  });

  it('allows additional updates in the current state and only forward state changes', () => {
    expect(canTransitionStatusPageIncident('INVESTIGATING', 'IDENTIFIED')).toBe(true);
    expect(canTransitionStatusPageIncident('INVESTIGATING', 'RESOLVED')).toBe(true);
    expect(canTransitionStatusPageIncident('MONITORING', 'RESOLVED')).toBe(true);
    expect(canTransitionStatusPageIncident('IDENTIFIED', 'INVESTIGATING')).toBe(false);
    expect(canTransitionStatusPageIncident('RESOLVED', 'MONITORING')).toBe(false);
    expect(canTransitionStatusPageIncident('INVESTIGATING', 'INVESTIGATING')).toBe(true);
    expect(canTransitionStatusPageIncident('IDENTIFIED', 'IDENTIFIED')).toBe(true);
    expect(canTransitionStatusPageIncident('RESOLVED', 'RESOLVED')).toBe(false);
  });
});
