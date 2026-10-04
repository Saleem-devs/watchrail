import type { AssertionOutcome } from './assertion.js';

export const INCIDENT_FAILURE_THRESHOLD = 3;

export const SCHEDULED_OBSERVATIONS = ['HEALTHY', 'UNHEALTHY', 'INDETERMINATE'] as const;
export type ScheduledObservation = (typeof SCHEDULED_OBSERVATIONS)[number];
export const INCIDENT_OBSERVATIONS = SCHEDULED_OBSERVATIONS;
export type IncidentObservation = ScheduledObservation;

export interface IncidentObservationInput {
  outcome: 'PASS' | 'FAIL' | 'UNKNOWN';
  reason: string;
  assertionOutcome: AssertionOutcome;
}

export function classifyScheduledObservation(
  input: IncidentObservationInput,
): ScheduledObservation {
  if (input.reason === 'INTERNAL_ERROR' || input.reason === 'PROHIBITED_DESTINATION') {
    return 'INDETERMINATE';
  }

  if (input.outcome === 'FAIL' || input.outcome === 'UNKNOWN') return 'UNHEALTHY';
  if (input.assertionOutcome === 'FAIL') return 'UNHEALTHY';
  if (input.assertionOutcome === 'NOT_EVALUATED') return 'INDETERMINATE';
  return 'HEALTHY';
}

export const classifyIncidentObservation = classifyScheduledObservation;
