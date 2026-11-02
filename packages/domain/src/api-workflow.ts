import type { ResponseAssertionConfigurationV1 } from './assertion-persistence.js';
import type { RequestHeaderUpdate, StoredRequestHeader } from './request-header.js';
import type { TlsCertificatePolicy } from './tls.js';
import type { HttpMonitorMethod, HttpRequestBody, HttpStatusPolicy } from './monitor.js';

export const API_WORKFLOW_LIMITS = {
  minimumSteps: 2,
  maximumSteps: 10,
  maximumExtractionsPerStep: 16,
  maximumInitialVariables: 32,
  maximumVariables: 64,
  maximumVariableNameLength: 64,
  maximumVariableValueBytes: 16 * 1024,
} as const;

export interface ApiWorkflowExtraction {
  variable: string;
  selector: string;
  sensitive: boolean;
}

interface ApiWorkflowStepBase {
  id: string;
  name: string;
  url: string;
  method: HttpMonitorMethod;
  timeoutMs: number;
  followRedirects: boolean;
  statusPolicy: HttpStatusPolicy;
  tlsPolicy: TlsCertificatePolicy;
  requestBody: HttpRequestBody;
  extractions: ApiWorkflowExtraction[];
}

export interface ApiWorkflowStepInput extends ApiWorkflowStepBase {
  requestHeaders: RequestHeaderUpdate[];
  assertions: unknown;
}

export interface ApiWorkflowConfigurationInput {
  contractVersion: 1;
  steps: ApiWorkflowStepInput[];
}

export interface StoredApiWorkflowStepV1 extends ApiWorkflowStepBase {
  requestHeaders: StoredRequestHeader[];
  assertions: ResponseAssertionConfigurationV1;
}

export interface StoredApiWorkflowConfigurationV1 {
  contractVersion: 1;
  steps: StoredApiWorkflowStepV1[];
}
