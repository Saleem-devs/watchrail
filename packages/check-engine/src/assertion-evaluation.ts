import { ASSERTION_LIMITS, type AssertionEvaluationV1 } from '@watchrail/domain';

export function combineAssertionEvaluations(
  ...evaluations: readonly AssertionEvaluationV1[]
): AssertionEvaluationV1 {
  const diagnostics = evaluations.flatMap((evaluation) => evaluation.diagnostics);
  if (diagnostics.length > ASSERTION_LIMITS.maxAssertions) {
    throw new Error(
      `Cannot combine more than ${ASSERTION_LIMITS.maxAssertions} assertion diagnostics.`,
    );
  }

  const identities = new Set<string>();
  for (const diagnostic of diagnostics) {
    const identity = `${diagnostic.source}:${diagnostic.index}`;
    if (identities.has(identity)) {
      throw new Error(`Duplicate assertion diagnostic identity: ${identity}.`);
    }
    identities.add(identity);
  }

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
