import {
  ASSERTION_LIMITS,
  type AssertionDiagnostic,
  type AssertionEvaluationV1,
  type HeaderAssertion,
} from '@watchrail/domain';
import type { HttpResponseHeader } from './types.js';

export function evaluateHeaderAssertions(
  assertions: readonly HeaderAssertion[],
  headers: readonly HttpResponseHeader[],
): AssertionEvaluationV1 {
  assertBounded(assertions);
  const valuesByName = collectValues(headers);
  const diagnostics = assertions.map((assertion, index): AssertionDiagnostic => {
    const values = valuesByName.get(assertion.name.toLowerCase()) ?? [];
    const passed = matches(assertion, values);
    return {
      index,
      source: 'HEADER',
      subject: assertion.name.toLowerCase(),
      operator: assertion.operator,
      outcome: passed ? 'PASS' : 'FAIL',
      reason: passed ? 'MATCHED' : 'HEADER_MISMATCH',
    };
  });

  return {
    contractVersion: 1,
    outcome: diagnostics.some((diagnostic) => diagnostic.outcome === 'FAIL') ? 'FAIL' : 'PASS',
    diagnostics,
  };
}

export function notEvaluateHeaderAssertions(
  assertions: readonly HeaderAssertion[],
): AssertionEvaluationV1 {
  assertBounded(assertions);
  return {
    contractVersion: 1,
    outcome: assertions.length === 0 ? 'PASS' : 'NOT_EVALUATED',
    diagnostics: assertions.map((assertion, index) => ({
      index,
      source: 'HEADER',
      subject: assertion.name.toLowerCase(),
      operator: assertion.operator,
      outcome: 'NOT_EVALUATED',
      reason: 'RESPONSE_UNAVAILABLE',
    })),
  };
}

function matches(assertion: HeaderAssertion, values: readonly string[]): boolean {
  switch (assertion.operator) {
    case 'exists':
      return values.length > 0;
    case 'does_not_exist':
      return values.length === 0;
    case 'equals':
      return values.some((value) => value === assertion.target.value);
    case 'not_equals':
      return values.every((value) => value !== assertion.target.value);
    case 'contains':
      return values.some((value) => value.includes(assertion.target.value));
    case 'not_contains':
      return values.every((value) => !value.includes(assertion.target.value));
  }
}

function collectValues(headers: readonly HttpResponseHeader[]): Map<string, string[]> {
  const valuesByName = new Map<string, string[]>();
  for (const header of headers) {
    const name = header.name.toLowerCase();
    const values = valuesByName.get(name) ?? [];
    values.push(...header.values);
    valuesByName.set(name, values);
  }
  return valuesByName;
}

function assertBounded(assertions: readonly HeaderAssertion[]): void {
  if (assertions.length > ASSERTION_LIMITS.maxAssertions) {
    throw new Error(`Cannot evaluate more than ${ASSERTION_LIMITS.maxAssertions} assertions.`);
  }
}
