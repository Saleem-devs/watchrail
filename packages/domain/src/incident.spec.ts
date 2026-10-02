import { describe, expect, it } from 'vitest';
import { classifyIncidentObservation } from './incident.js';

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
    ['PASS', 'COMPLETED', 'NOT_EVALUATED', 'INDETERMINATE'],
  ] as const)('%s / %s / %s becomes %s', (outcome, reason, assertionOutcome, expected) => {
    expect(classifyIncidentObservation({ outcome, reason, assertionOutcome })).toBe(expected);
  });
});
