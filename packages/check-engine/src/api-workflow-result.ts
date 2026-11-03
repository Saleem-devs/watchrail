import { isValidJsonSelector, parseStoredAssertionEvaluation } from '@watchrail/domain';
import {
  API_WORKFLOW_LIMITS,
  type ApiWorkflowExecutedStepResult,
  type ApiWorkflowResult,
} from './api-workflow-types.js';

type JsonValue<T> = T extends Date
  ? string
  : T extends readonly (infer Item)[]
    ? JsonValue<Item>[]
    : T extends object
      ? { [Key in keyof T]: JsonValue<T[Key]> }
      : T;

export type SerializedApiWorkflowResult = JsonValue<ApiWorkflowResult>;

export function serializeApiWorkflowResult(result: ApiWorkflowResult): SerializedApiWorkflowResult {
  return JSON.parse(JSON.stringify(result)) as SerializedApiWorkflowResult;
}

export function parseApiWorkflowResult(value: unknown): ApiWorkflowResult {
  if (
    !hasExactKeys(value, [
      'attemptDurationMs',
      'checkedAt',
      'failedStepId',
      'outcome',
      'reason',
      'stage',
      'steps',
    ]) ||
    value.stage !== 'WORKFLOW' ||
    !isNonNegativeNumber(value.attemptDurationMs) ||
    !isCanonicalTimestamp(value.checkedAt) ||
    !Array.isArray(value.steps) ||
    value.steps.length < API_WORKFLOW_LIMITS.minimumSteps ||
    value.steps.length > API_WORKFLOW_LIMITS.maximumSteps
  ) {
    throw new TypeError('API workflow result is invalid.');
  }
  const steps = value.steps.map((step, position) => parseStep(step, position));
  if (new Set(steps.map((step) => step.id)).size !== steps.length) throwInvalidResult();
  const outcome = String(value.outcome);
  const reason = String(value.reason);
  const failedStepId = value.failedStepId;
  if (outcome === 'PASS') {
    if (reason !== 'WORKFLOW_COMPLETED' || failedStepId !== null) throwInvalidResult();
  } else if (outcome === 'FAIL') {
    if (!['STEP_FAILED', 'EXTRACTION_FAILED'].includes(reason) || !isStepId(failedStepId, steps)) {
      throwInvalidResult();
    }
  } else if (outcome === 'UNKNOWN') {
    if (
      ![
        'STEP_INDETERMINATE',
        'EXTRACTION_INDETERMINATE',
        'VARIABLE_UNAVAILABLE',
        'INTERNAL_ERROR',
      ].includes(reason) ||
      !isStepId(failedStepId, steps)
    ) {
      throwInvalidResult();
    }
  } else {
    throwInvalidResult();
  }
  assertResultSemantics(outcome, reason, failedStepId, steps);
  return {
    ...(value as unknown as ApiWorkflowResult),
    checkedAt: new Date(value.checkedAt),
    steps,
  };
}

function assertResultSemantics(
  outcome: string,
  reason: string,
  failedStepId: unknown,
  steps: ApiWorkflowResult['steps'],
): void {
  if (outcome === 'PASS') {
    if (
      steps.some(
        (step) =>
          step.status !== 'EXECUTED' ||
          step.result.outcome !== 'PASS' ||
          step.extractions.some((diagnostic) => diagnostic.outcome !== 'CAPTURED'),
      )
    ) {
      throwInvalidResult();
    }
    return;
  }
  const failedIndex = steps.findIndex((step) => step.id === failedStepId);
  if (failedIndex < 0) throwInvalidResult();
  const failed = steps[failedIndex]!;
  const earlier = steps.slice(0, failedIndex);
  const later = steps.slice(failedIndex + 1);
  if (
    earlier.some(
      (step) =>
        step.status !== 'EXECUTED' ||
        step.result.outcome !== 'PASS' ||
        step.extractions.some((diagnostic) => diagnostic.outcome !== 'CAPTURED'),
    ) ||
    later.some((step) => step.status !== 'SKIPPED')
  ) {
    throwInvalidResult();
  }
  if (reason === 'STEP_FAILED') {
    if (failed.status !== 'EXECUTED' || failed.result.outcome !== 'FAIL') throwInvalidResult();
    return;
  }
  if (reason === 'STEP_INDETERMINATE') {
    if (failed.status !== 'EXECUTED' || failed.result.outcome !== 'UNKNOWN') throwInvalidResult();
    return;
  }
  if (reason === 'EXTRACTION_FAILED' || reason === 'EXTRACTION_INDETERMINATE') {
    const expected = reason === 'EXTRACTION_FAILED' ? 'FAILED' : 'NOT_EVALUATED';
    if (
      failed.status !== 'EXECUTED' ||
      failed.result.outcome !== 'PASS' ||
      !failed.extractions.some((diagnostic) => diagnostic.outcome === expected)
    ) {
      throwInvalidResult();
    }
    return;
  }
  if (reason === 'VARIABLE_UNAVAILABLE') {
    if (failed.status !== 'SKIPPED' || failed.reason !== 'VARIABLE_UNAVAILABLE') {
      throwInvalidResult();
    }
    return;
  }
  if (reason === 'INTERNAL_ERROR') {
    if (failed.status !== 'SKIPPED' || failed.reason !== 'EXECUTION_ERROR') throwInvalidResult();
    return;
  }
  throwInvalidResult();
}

function parseStep(value: unknown, position: number): ApiWorkflowResult['steps'][number] {
  if (
    !isRecord(value) ||
    value.position !== position ||
    typeof value.id !== 'string' ||
    !/^[A-Za-z0-9_-]{1,64}$/u.test(value.id) ||
    typeof value.name !== 'string' ||
    value.name.length < 1 ||
    value.name.length > 120
  ) {
    throwInvalidResult();
  }
  if (value.status === 'SKIPPED') {
    if (
      !hasExactKeys(value, ['id', 'name', 'position', 'reason', 'status']) ||
      ![
        'VARIABLE_UNAVAILABLE',
        'EXECUTION_ERROR',
        'PREVIOUS_STEP_FAILED',
        'PREVIOUS_STEP_INDETERMINATE',
      ].includes(String(value.reason))
    ) {
      throwInvalidResult();
    }
    return value as unknown as ApiWorkflowResult['steps'][number];
  }
  if (
    value.status !== 'EXECUTED' ||
    !hasExactKeys(value, ['extractions', 'id', 'name', 'position', 'result', 'status']) ||
    !Array.isArray(value.extractions) ||
    value.extractions.length > API_WORKFLOW_LIMITS.maximumExtractionsPerStep ||
    !hasExactKeys(value.result, [
      'assertionEvaluation',
      'attemptDurationMs',
      'checkedAt',
      'outcome',
      'reason',
      'redirectCount',
      'responseTimeMs',
      'stage',
      'statusCode',
      'tlsCertificateCount',
    ]) ||
    !isCanonicalTimestamp(value.result.checkedAt) ||
    !isNonNegativeNumber(value.result.attemptDurationMs) ||
    !isNullableNonNegativeNumber(value.result.responseTimeMs) ||
    !isNullableStatusCode(value.result.statusCode) ||
    !isNonNegativeInteger(value.result.redirectCount) ||
    !isNonNegativeInteger(value.result.tlsCertificateCount) ||
    !isValidHttpStepClassification(value.result)
  ) {
    throwInvalidResult();
  }
  const result = {
    ...value.result,
    checkedAt: new Date(value.result.checkedAt),
    assertionEvaluation: parseStoredAssertionEvaluation(value.result.assertionEvaluation),
  } as ApiWorkflowExecutedStepResult['result'];
  const extractions = value.extractions.map((diagnostic) => {
    if (
      !hasExactKeys(diagnostic, ['outcome', 'reason', 'selector', 'sensitive', 'variable']) ||
      typeof diagnostic.variable !== 'string' ||
      !/^[A-Za-z_][A-Za-z0-9_]{0,63}$/u.test(diagnostic.variable) ||
      typeof diagnostic.selector !== 'string' ||
      !isValidJsonSelector(diagnostic.selector) ||
      typeof diagnostic.sensitive !== 'boolean' ||
      !['CAPTURED', 'FAILED', 'NOT_EVALUATED'].includes(String(diagnostic.outcome)) ||
      ![
        'CAPTURED',
        'BODY_UNAVAILABLE',
        'INVALID_JSON',
        'VALUE_MISSING',
        'NON_SCALAR_VALUE',
        'VALUE_TOO_LARGE',
      ].includes(String(diagnostic.reason))
    ) {
      throwInvalidResult();
    }
    return diagnostic;
  });
  return { ...value, result, extractions } as unknown as ApiWorkflowResult['steps'][number];
}

function isValidHttpStepClassification(value: Record<string, unknown>): boolean {
  const outcome = String(value.outcome);
  const stage = String(value.stage);
  const reason = String(value.reason);
  if (!['PASS', 'FAIL', 'UNKNOWN'].includes(outcome)) return false;
  if (!['DNS', 'CONNECT', 'TLS', 'HTTP', 'PROBE'].includes(stage)) return false;
  if (reason === 'COMPLETED') return outcome === 'PASS' && stage === 'HTTP';
  if (reason === 'PROHIBITED_DESTINATION') return outcome === 'UNKNOWN' && stage === 'DNS';
  if (reason === 'CERTIFICATE_EVIDENCE_UNAVAILABLE') {
    return outcome === 'UNKNOWN' && stage === 'TLS';
  }
  if (reason === 'INTERNAL_ERROR') return outcome === 'UNKNOWN' && stage === 'PROBE';
  if (reason === 'NAME_NOT_FOUND') return outcome === 'FAIL' && stage === 'DNS';
  if (['CONNECTION_REFUSED', 'HOST_UNREACHABLE', 'CONNECTION_TIMEOUT'].includes(reason)) {
    return outcome === 'FAIL' && stage === 'CONNECT';
  }
  if (
    [
      'CERTIFICATE_EXPIRED',
      'CERTIFICATE_NOT_YET_VALID',
      'CERTIFICATE_HOSTNAME_MISMATCH',
      'CERTIFICATE_UNTRUSTED',
      'CERTIFICATE_EXPIRING',
      'TLS_HANDSHAKE_FAILED',
    ].includes(reason)
  ) {
    return outcome === 'FAIL' && stage === 'TLS';
  }
  return (
    outcome === 'FAIL' &&
    stage === 'HTTP' &&
    [
      'UNEXPECTED_STATUS',
      'REQUEST_TIMEOUT',
      'REDIRECT_LOOP',
      'TOO_MANY_REDIRECTS',
      'MISSING_REDIRECT_LOCATION',
      'INVALID_REDIRECT_LOCATION',
      'INSECURE_REDIRECT',
    ].includes(reason)
  );
}

function isStepId(value: unknown, steps: ApiWorkflowResult['steps']): value is string {
  return typeof value === 'string' && steps.some((step) => step.id === value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: unknown,
  expected: readonly string[],
): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value).sort();
  const required = [...expected].sort();
  return keys.length === required.length && keys.every((key, index) => key === required[index]);
}

function isCanonicalTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString() === value;
}

function isNonNegativeNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isNullableNonNegativeNumber(value: unknown): value is number | null {
  return value === null || isNonNegativeNumber(value);
}

function isNullableStatusCode(value: unknown): value is number | null {
  return (
    value === null || (Number.isInteger(value) && Number(value) >= 100 && Number(value) <= 599)
  );
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function throwInvalidResult(): never {
  throw new TypeError('API workflow result is invalid.');
}
