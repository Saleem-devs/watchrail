import {
  ASSERTION_LIMITS,
  type AssertionDiagnostic,
  type AssertionDiagnosticReason,
  type AssertionEvaluationV1,
  type TextBodyAssertion,
} from '@watchrail/domain';
import { combineAssertionEvaluations } from './assertion-evaluation.js';
import type { HttpBodyCapture } from './types.js';

type UnavailableBodyReason = Extract<
  AssertionDiagnosticReason,
  | 'BODY_TOO_LARGE'
  | 'UNSUPPORTED_CONTENT_ENCODING'
  | 'UNSUPPORTED_CHARSET'
  | 'BODY_READ_FAILED'
  | 'RESPONSE_UNAVAILABLE'
>;

export function evaluateTextBodyAssertions(
  assertions: readonly TextBodyAssertion[],
  body: HttpBodyCapture,
): AssertionEvaluationV1 {
  assertBounded(assertions);
  if (body.state !== 'CAPTURED') {
    return notEvaluateTextBodyAssertions(
      assertions,
      body.state === 'UNAVAILABLE' ? body.reason : 'RESPONSE_UNAVAILABLE',
    );
  }

  const diagnostics = assertions.map((assertion, index): AssertionDiagnostic => {
    const passed = matches(assertion, body.text);
    return {
      index,
      source: 'TEXT_BODY',
      subject: null,
      operator: assertion.operator,
      outcome: passed ? 'PASS' : 'FAIL',
      reason: passed ? 'MATCHED' : 'TEXT_BODY_MISMATCH',
    };
  });
  return combineAssertionEvaluations({ contractVersion: 1, outcome: 'PASS', diagnostics });
}

export function notEvaluateTextBodyAssertions(
  assertions: readonly TextBodyAssertion[],
  reason: UnavailableBodyReason = 'RESPONSE_UNAVAILABLE',
): AssertionEvaluationV1 {
  assertBounded(assertions);
  return combineAssertionEvaluations({
    contractVersion: 1,
    outcome: 'PASS',
    diagnostics: assertions.map((assertion, index) => ({
      index,
      source: 'TEXT_BODY',
      subject: null,
      operator: assertion.operator,
      outcome: 'NOT_EVALUATED',
      reason,
    })),
  });
}

function matches(assertion: TextBodyAssertion, body: string): boolean {
  switch (assertion.operator) {
    case 'equals':
      return body === assertion.target.value;
    case 'not_equals':
      return body !== assertion.target.value;
    case 'contains':
      return body.includes(assertion.target.value);
    case 'not_contains':
      return !body.includes(assertion.target.value);
  }
}

function assertBounded(assertions: readonly TextBodyAssertion[]): void {
  if (assertions.length > ASSERTION_LIMITS.maxAssertions) {
    throw new Error(`Cannot evaluate more than ${ASSERTION_LIMITS.maxAssertions} assertions.`);
  }
}
