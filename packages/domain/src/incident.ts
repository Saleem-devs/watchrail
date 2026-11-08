import type { AssertionOutcome } from './assertion.js';

export const INCIDENT_FAILURE_THRESHOLD = 3;
export const DOMAIN_EXPIRY_INCIDENT_FAILURE_THRESHOLD = 1;

export const INCIDENT_SEVERITIES = ['DEGRADED', 'DOWN'] as const;
export type IncidentSeverity = (typeof INCIDENT_SEVERITIES)[number];

export function incidentGroupKey(monitorId: string): string {
  return `availability:${monitorId.toLowerCase()}`;
}

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
  if (
    input.reason === 'INTERNAL_ERROR' ||
    input.reason === 'PROHIBITED_DESTINATION' ||
    input.reason === 'CERTIFICATE_EVIDENCE_UNAVAILABLE' ||
    input.reason === 'RDAP_UNAVAILABLE' ||
    input.reason === 'RDAP_UNSUPPORTED_TLD' ||
    input.reason === 'DOMAIN_EXPIRATION_UNAVAILABLE' ||
    input.reason === 'STEP_INDETERMINATE' ||
    input.reason === 'EXTRACTION_INDETERMINATE' ||
    input.reason === 'VARIABLE_UNAVAILABLE'
  ) {
    return 'INDETERMINATE';
  }

  if (input.outcome === 'FAIL' || input.outcome === 'UNKNOWN') return 'UNHEALTHY';
  if (input.assertionOutcome === 'FAIL') return 'UNHEALTHY';
  if (input.assertionOutcome === 'NOT_EVALUATED') return 'INDETERMINATE';
  return 'HEALTHY';
}

export const classifyIncidentObservation = classifyScheduledObservation;
