import type { HttpCheckInput, HttpCheckResult, HttpExecutor } from './types.js';
import type { CheckClock } from './types.js';

export const API_WORKFLOW_LIMITS = {
  minimumSteps: 2,
  maximumSteps: 10,
  maximumExtractionsPerStep: 16,
  maximumVariableNameLength: 64,
} as const;

export interface ApiWorkflowExtraction {
  variable: string;
  selector: string;
  sensitive: boolean;
}

export interface ApiWorkflowStep extends Omit<HttpCheckInput, 'captureResponseEvidence'> {
  id: string;
  name: string;
  extractions: readonly ApiWorkflowExtraction[];
}

export interface ApiWorkflowInput {
  steps: readonly ApiWorkflowStep[];
  initialVariables?: Readonly<Record<string, string>>;
}

type WithoutResponseEvidence<T> = T extends unknown ? Omit<T, 'responseEvidence'> : never;

export interface ApiWorkflowExtractionDiagnostic {
  variable: string;
  selector: string;
  outcome: 'CAPTURED' | 'FAILED';
  reason: 'CAPTURED' | 'BODY_UNAVAILABLE' | 'INVALID_JSON' | 'VALUE_MISSING' | 'NON_SCALAR_VALUE';
  sensitive: boolean;
}

export interface ApiWorkflowExecutedStepResult {
  id: string;
  name: string;
  position: number;
  status: 'EXECUTED';
  result: WithoutResponseEvidence<HttpCheckResult>;
  extractions: ApiWorkflowExtractionDiagnostic[];
}

export interface ApiWorkflowSkippedStepResult {
  id: string;
  name: string;
  position: number;
  status: 'SKIPPED';
  reason: 'VARIABLE_UNAVAILABLE' | 'PREVIOUS_STEP_FAILED' | 'PREVIOUS_STEP_INDETERMINATE';
}

export type ApiWorkflowStepResult = ApiWorkflowExecutedStepResult | ApiWorkflowSkippedStepResult;

interface ApiWorkflowResultBase {
  checkedAt: Date;
  attemptDurationMs: number;
  steps: ApiWorkflowStepResult[];
  failedStepId: string | null;
}

export type ApiWorkflowResult =
  | (ApiWorkflowResultBase & {
      outcome: 'PASS';
      stage: 'WORKFLOW';
      reason: 'WORKFLOW_COMPLETED';
      failedStepId: null;
    })
  | (ApiWorkflowResultBase & {
      outcome: 'FAIL';
      stage: 'WORKFLOW';
      reason: 'STEP_FAILED' | 'EXTRACTION_FAILED';
      failedStepId: string;
    })
  | (ApiWorkflowResultBase & {
      outcome: 'UNKNOWN';
      stage: 'WORKFLOW';
      reason: 'STEP_INDETERMINATE' | 'VARIABLE_UNAVAILABLE' | 'INTERNAL_ERROR';
      failedStepId: string;
    });

export interface ApiWorkflowDependencies {
  executor: HttpExecutor;
  clock?: CheckClock;
  signal?: AbortSignal;
}
