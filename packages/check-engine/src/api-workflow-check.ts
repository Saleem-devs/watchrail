import { isValidJsonSelector } from '@watchrail/domain';
import { executeHttpCheck } from './http-check.js';
import { resolveJsonSelector } from './json-body-assertions.js';
import { parseStrictJson, type StrictJsonValue } from './strict-json-parser.js';
import {
  API_WORKFLOW_LIMITS,
  type ApiWorkflowDependencies,
  type ApiWorkflowExtraction,
  type ApiWorkflowExtractionDiagnostic,
  type ApiWorkflowInput,
  type ApiWorkflowResult,
  type ApiWorkflowStep,
  type ApiWorkflowStepResult,
} from './api-workflow-types.js';
import type { CheckClock, HttpCheckInput, HttpCheckResult } from './types.js';

const VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/u;
const VARIABLE_REFERENCE = /\{\{([A-Za-z_][A-Za-z0-9_]{0,63})\}\}/gu;

const defaultClock: CheckClock = {
  now: () => new Date(),
  monotonicNow: () => performance.now(),
};

export async function executeApiWorkflow(
  input: ApiWorkflowInput,
  dependencies: ApiWorkflowDependencies,
): Promise<ApiWorkflowResult> {
  assertWorkflow(input);
  const clock = dependencies.clock ?? defaultClock;
  const checkedAt = clock.now();
  const startedAt = clock.monotonicNow();
  const variables = new Map(Object.entries(input.initialVariables ?? {}));
  const steps: ApiWorkflowStepResult[] = [];

  for (let position = 0; position < input.steps.length; position += 1) {
    const step = input.steps[position]!;
    let request: HttpCheckInput;
    try {
      request = resolveStep(step, variables);
    } catch (error) {
      if (!(error instanceof MissingWorkflowVariableError)) throw error;
      steps.push(skippedStep(step, position, 'VARIABLE_UNAVAILABLE'));
      appendSkippedSteps(input.steps, position + 1, 'PREVIOUS_STEP_INDETERMINATE', steps);
      return terminalResult(
        'UNKNOWN',
        'VARIABLE_UNAVAILABLE',
        step.id,
        checkedAt,
        elapsed(clock, startedAt),
        steps,
      );
    }

    let result: HttpCheckResult;
    try {
      result = await executeHttpCheck(
        { ...request, captureResponseEvidence: true },
        {
          executor: dependencies.executor,
          clock,
          ...(dependencies.signal === undefined ? {} : { signal: dependencies.signal }),
        },
      );
    } catch {
      return terminalResult(
        'UNKNOWN',
        'INTERNAL_ERROR',
        step.id,
        checkedAt,
        elapsed(clock, startedAt),
        steps,
      );
    }

    const safeResult = withoutResponseEvidence(result);
    if (result.outcome !== 'PASS') {
      steps.push({
        id: step.id,
        name: step.name,
        position,
        status: 'EXECUTED',
        result: safeResult,
        extractions: [],
      });
      appendSkippedSteps(
        input.steps,
        position + 1,
        result.outcome === 'FAIL' ? 'PREVIOUS_STEP_FAILED' : 'PREVIOUS_STEP_INDETERMINATE',
        steps,
      );
      return result.outcome === 'FAIL'
        ? terminalResult(
            'FAIL',
            'STEP_FAILED',
            step.id,
            checkedAt,
            elapsed(clock, startedAt),
            steps,
          )
        : terminalResult(
            'UNKNOWN',
            'STEP_INDETERMINATE',
            step.id,
            checkedAt,
            elapsed(clock, startedAt),
            steps,
          );
    }

    const extraction = extractVariables(step.extractions, result, variables);
    steps.push({
      id: step.id,
      name: step.name,
      position,
      status: 'EXECUTED',
      result: safeResult,
      extractions: extraction.diagnostics,
    });
    if (!extraction.succeeded) {
      appendSkippedSteps(input.steps, position + 1, 'PREVIOUS_STEP_FAILED', steps);
      return terminalResult(
        'FAIL',
        'EXTRACTION_FAILED',
        step.id,
        checkedAt,
        elapsed(clock, startedAt),
        steps,
      );
    }
  }

  return {
    outcome: 'PASS',
    stage: 'WORKFLOW',
    reason: 'WORKFLOW_COMPLETED',
    failedStepId: null,
    checkedAt,
    attemptDurationMs: elapsed(clock, startedAt),
    steps,
  };
}

function resolveStep(
  step: ApiWorkflowStep,
  variables: ReadonlyMap<string, string>,
): HttpCheckInput {
  const requestBody = resolveRequestBody(step.requestBody, variables);
  return {
    url: substitute(step.url, variables),
    method: step.method,
    timeoutMs: step.timeoutMs,
    followRedirects: step.followRedirects,
    ...(step.statusPolicy === undefined ? {} : { statusPolicy: step.statusPolicy }),
    ...(step.tlsPolicy === undefined ? {} : { tlsPolicy: step.tlsPolicy }),
    requestHeaders: (step.requestHeaders ?? []).map((header) => ({
      name: header.name,
      value: substitute(header.value, variables),
    })),
    ...(requestBody === undefined ? {} : { requestBody }),
    headerAssertions: (step.headerAssertions ?? []).map((assertion) =>
      'target' in assertion
        ? {
            ...assertion,
            target: { ...assertion.target, value: substitute(assertion.target.value, variables) },
          }
        : assertion,
    ),
    textBodyAssertions: (step.textBodyAssertions ?? []).map((assertion) => ({
      ...assertion,
      target: { ...assertion.target, value: substitute(assertion.target.value, variables) },
    })),
    jsonBodyAssertions: (step.jsonBodyAssertions ?? []).map((assertion) => {
      if (!('target' in assertion) || assertion.target.value.type !== 'string') return assertion;
      return {
        ...assertion,
        target: {
          ...assertion.target,
          value: {
            type: 'string' as const,
            value: substitute(assertion.target.value.value, variables),
          },
        },
      };
    }),
  };
}

function resolveRequestBody(
  body: ApiWorkflowStep['requestBody'],
  variables: ReadonlyMap<string, string>,
): ApiWorkflowStep['requestBody'] {
  if (body === undefined || body.type === 'NONE') return body;
  if (body.type === 'FORM_URLENCODED') {
    return {
      ...body,
      fields: body.fields.map((field) => ({
        name: field.name,
        value: substitute(field.value, variables),
      })),
    };
  }
  return { ...body, value: substitute(body.value, variables) };
}

function extractVariables(
  extractions: readonly ApiWorkflowExtraction[],
  result: HttpCheckResult,
  variables: Map<string, string>,
): { succeeded: boolean; diagnostics: ApiWorkflowExtractionDiagnostic[] } {
  if (extractions.length === 0) return { succeeded: true, diagnostics: [] };
  const body = result.responseEvidence?.body;
  if (body?.state !== 'CAPTURED') {
    return {
      succeeded: false,
      diagnostics: extractions.map((item) => diagnostic(item, 'FAILED', 'BODY_UNAVAILABLE')),
    };
  }
  const parsed = parseStrictJson(body.text);
  if (parsed.status === 'FAILED') {
    return {
      succeeded: false,
      diagnostics: extractions.map((item) => diagnostic(item, 'FAILED', 'INVALID_JSON')),
    };
  }

  const pending = new Map<string, string>();
  const diagnostics = extractions.map((item): ApiWorkflowExtractionDiagnostic => {
    const resolution = resolveJsonSelector(parsed.value, item.selector);
    if (resolution.state === 'MISSING') return diagnostic(item, 'FAILED', 'VALUE_MISSING');
    const value = scalarText(resolution.value);
    if (value === null) return diagnostic(item, 'FAILED', 'NON_SCALAR_VALUE');
    pending.set(item.variable, value);
    return diagnostic(item, 'CAPTURED', 'CAPTURED');
  });
  if (diagnostics.some((item) => item.outcome === 'FAILED')) {
    return { succeeded: false, diagnostics };
  }
  for (const [name, value] of pending) variables.set(name, value);
  return { succeeded: true, diagnostics };
}

function scalarText(value: StrictJsonValue): string | null {
  switch (value.type) {
    case 'string':
    case 'number':
      return value.value;
    case 'boolean':
      return String(value.value);
    case 'null':
      return 'null';
    case 'object':
    case 'array':
      return null;
  }
}

function diagnostic(
  extraction: ApiWorkflowExtraction,
  outcome: ApiWorkflowExtractionDiagnostic['outcome'],
  reason: ApiWorkflowExtractionDiagnostic['reason'],
): ApiWorkflowExtractionDiagnostic {
  return {
    variable: extraction.variable,
    selector: extraction.selector,
    sensitive: extraction.sensitive,
    outcome,
    reason,
  };
}

function withoutResponseEvidence(
  result: HttpCheckResult,
): Extract<ApiWorkflowStepResult, { status: 'EXECUTED' }>['result'] {
  const { responseEvidence: _responseEvidence, ...safe } = result;
  return safe;
}

function substitute(value: string, variables: ReadonlyMap<string, string>): string {
  return value.replace(VARIABLE_REFERENCE, (_match, name: string) => {
    const replacement = variables.get(name);
    if (replacement === undefined) throw new MissingWorkflowVariableError();
    return replacement;
  });
}

function assertWorkflow(input: ApiWorkflowInput): void {
  if (
    input.steps.length < API_WORKFLOW_LIMITS.minimumSteps ||
    input.steps.length > API_WORKFLOW_LIMITS.maximumSteps
  ) {
    throw new RangeError(
      `API workflows require ${API_WORKFLOW_LIMITS.minimumSteps} to ${API_WORKFLOW_LIMITS.maximumSteps} steps.`,
    );
  }
  const stepIds = new Set<string>();
  const variables = new Set(Object.keys(input.initialVariables ?? {}));
  for (const name of variables) assertVariableName(name);
  for (const step of input.steps) {
    if (step.id.trim() === '' || step.name.trim() === '' || stepIds.has(step.id)) {
      throw new TypeError('API workflow steps require unique IDs and non-empty names.');
    }
    stepIds.add(step.id);
    for (const reference of referencedVariables(step)) {
      if (!variables.has(reference)) {
        throw new TypeError(
          'API workflow step references a variable that is not available from an earlier step.',
        );
      }
    }
    if (step.extractions.length > API_WORKFLOW_LIMITS.maximumExtractionsPerStep) {
      throw new RangeError('API workflow step has too many variable extractions.');
    }
    for (const extraction of step.extractions) {
      assertVariableName(extraction.variable);
      if (!isValidJsonSelector(extraction.selector) || variables.has(extraction.variable)) {
        throw new TypeError('API workflow extraction is invalid or redefines a variable.');
      }
      variables.add(extraction.variable);
    }
  }
}

function referencedVariables(step: ApiWorkflowStep): Set<string> {
  const values = [
    step.url,
    ...(step.requestHeaders ?? []).map((header) => header.value),
    ...requestBodyValues(step.requestBody),
    ...(step.headerAssertions ?? []).flatMap((assertion) =>
      'target' in assertion ? [assertion.target.value] : [],
    ),
    ...(step.textBodyAssertions ?? []).map((assertion) => assertion.target.value),
    ...(step.jsonBodyAssertions ?? []).flatMap((assertion) =>
      'target' in assertion && assertion.target.value.type === 'string'
        ? [assertion.target.value.value]
        : [],
    ),
  ];
  const references = new Set<string>();
  for (const value of values) {
    for (const match of value.matchAll(VARIABLE_REFERENCE)) references.add(match[1]!);
  }
  return references;
}

function requestBodyValues(body: ApiWorkflowStep['requestBody']): string[] {
  if (body === undefined || body.type === 'NONE') return [];
  if (body.type === 'FORM_URLENCODED') return body.fields.map((field) => field.value);
  return [body.value];
}

function appendSkippedSteps(
  configured: readonly ApiWorkflowStep[],
  start: number,
  reason: ApiWorkflowSkippedReason,
  results: ApiWorkflowStepResult[],
): void {
  for (let position = start; position < configured.length; position += 1) {
    results.push(skippedStep(configured[position]!, position, reason));
  }
}

type ApiWorkflowSkippedReason = Extract<ApiWorkflowStepResult, { status: 'SKIPPED' }>['reason'];

function skippedStep(
  step: ApiWorkflowStep,
  position: number,
  reason: ApiWorkflowSkippedReason,
): Extract<ApiWorkflowStepResult, { status: 'SKIPPED' }> {
  return { id: step.id, name: step.name, position, status: 'SKIPPED', reason };
}

function assertVariableName(name: string): void {
  if (!VARIABLE_NAME.test(name)) throw new TypeError('API workflow variable name is invalid.');
}

function terminalResult(
  outcome: 'FAIL',
  reason: 'STEP_FAILED' | 'EXTRACTION_FAILED',
  failedStepId: string,
  checkedAt: Date,
  attemptDurationMs: number,
  steps: ApiWorkflowStepResult[],
): ApiWorkflowResult;
function terminalResult(
  outcome: 'UNKNOWN',
  reason: 'STEP_INDETERMINATE' | 'VARIABLE_UNAVAILABLE' | 'INTERNAL_ERROR',
  failedStepId: string,
  checkedAt: Date,
  attemptDurationMs: number,
  steps: ApiWorkflowStepResult[],
): ApiWorkflowResult;
function terminalResult(
  outcome: 'FAIL' | 'UNKNOWN',
  reason: ApiWorkflowResult['reason'],
  failedStepId: string,
  checkedAt: Date,
  attemptDurationMs: number,
  steps: ApiWorkflowStepResult[],
): ApiWorkflowResult {
  if (outcome === 'FAIL') {
    return {
      outcome,
      stage: 'WORKFLOW',
      reason: reason as 'STEP_FAILED' | 'EXTRACTION_FAILED',
      failedStepId,
      checkedAt,
      attemptDurationMs,
      steps,
    };
  }
  return {
    outcome,
    stage: 'WORKFLOW',
    reason: reason as 'STEP_INDETERMINATE' | 'VARIABLE_UNAVAILABLE' | 'INTERNAL_ERROR',
    failedStepId,
    checkedAt,
    attemptDurationMs,
    steps,
  };
}

function elapsed(clock: CheckClock, startedAt: number): number {
  return Math.max(0, Math.round(clock.monotonicNow() - startedAt));
}

class MissingWorkflowVariableError extends Error {}
