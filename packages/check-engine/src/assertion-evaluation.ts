import type { AssertionEvaluationV1 } from '@watchrail/domain';

export function combineAssertionEvaluations(
  ...evaluations: readonly AssertionEvaluationV1[]
): AssertionEvaluationV1 {
  const diagnostics = evaluations.flatMap((evaluation) => evaluation.diagnostics);
  return {
    contractVersion: 1,
    outcome: diagnostics.some((diagnostic) => diagnostic.outcome === 'FAIL')
      ? 'FAIL'
      : diagnostics.some((diagnostic) => diagnostic.outcome === 'NOT_EVALUATED')
        ? 'NOT_EVALUATED'
        : 'PASS',
    diagnostics,
  };
}
