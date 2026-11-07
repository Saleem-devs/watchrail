import { describe, expect, it } from 'vitest';
import { classifyIncidentObservation, incidentGroupKey } from './incident.js';

describe('incidentGroupKey', () => {
  it('creates a stable canonical availability group for a monitor', () => {
    expect(incidentGroupKey('A0D83FC4-33D7-4ED5-8168-C46389418E74')).toBe(
      'availability:a0d83fc4-33d7-4ed5-8168-c46389418e74',
    );
  });
});

describe('classifyIncidentObservation', () => {
  it.each([
    ['PASS', 'COMPLETED', 'PASS', 'HEALTHY'],
    ['FAIL', 'UNEXPECTED_STATUS', 'PASS', 'UNHEALTHY'],
    ['PASS', 'COMPLETED', 'FAIL', 'UNHEALTHY'],
    ['UNKNOWN', 'NAME_NOT_FOUND', 'PASS', 'UNHEALTHY'],
    ['UNKNOWN', 'CONNECTION_REFUSED', 'PASS', 'UNHEALTHY'],
    ['FAIL', 'REQUEST_TIMEOUT', 'PASS', 'UNHEALTHY'],
    ['UNKNOWN', 'INTERNAL_ERROR', 'PASS', 'INDETERMINATE'],
    ['UNKNOWN', 'PROHIBITED_DESTINATION', 'PASS', 'INDETERMINATE'],
    ['UNKNOWN', 'CERTIFICATE_EVIDENCE_UNAVAILABLE', 'PASS', 'INDETERMINATE'],
    ['PASS', 'WORKFLOW_COMPLETED', 'PASS', 'HEALTHY'],
    ['FAIL', 'STEP_FAILED', 'PASS', 'UNHEALTHY'],
    ['FAIL', 'EXTRACTION_FAILED', 'PASS', 'UNHEALTHY'],
    ['UNKNOWN', 'STEP_INDETERMINATE', 'PASS', 'INDETERMINATE'],
    ['UNKNOWN', 'EXTRACTION_INDETERMINATE', 'PASS', 'INDETERMINATE'],
    ['UNKNOWN', 'VARIABLE_UNAVAILABLE', 'PASS', 'INDETERMINATE'],
    ['PASS', 'COMPLETED', 'NOT_EVALUATED', 'INDETERMINATE'],
  ] as const)('%s / %s / %s becomes %s', (outcome, reason, assertionOutcome, expected) => {
    expect(classifyIncidentObservation({ outcome, reason, assertionOutcome })).toBe(expected);
  });
});
