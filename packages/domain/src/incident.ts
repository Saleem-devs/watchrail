import type { AssertionOutcome } from './assertion.js';

export const INCIDENT_FAILURE_THRESHOLD = 3;

export const INCIDENT_OBSERVATIONS = ['HEALTHY', 'UNHEALTHY', 'INDETERMINATE'] as const;
export type IncidentObservation = (typeof INCIDENT_OBSERVATIONS)[number];

export interface IncidentObservationInput {
  outcome: 'PASS' | 'FAIL' | 'UNKNOWN';
  reason: string;
  assertionOutcome: AssertionOutcome;
}

export function classifyIncidentObservation(input: IncidentObservationInput): IncidentObservation {
  if (input.reason === 'INTERNAL_ERROR' || input.reason === 'PROHIBITED_DESTINATION') {
    return 'INDETERMINATE';
  }

  if (input.outcome === 'FAIL' || input.outcome === 'UNKNOWN') return 'UNHEALTHY';
  if (input.assertionOutcome === 'FAIL') return 'UNHEALTHY';
  if (input.assertionOutcome === 'NOT_EVALUATED') return 'INDETERMINATE';
  return 'HEALTHY';
}
