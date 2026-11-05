import type { ResponseAssertionConfigurationV1 } from './assertion-persistence.js';
import type {
  EncryptedHeaderValueV1,
  RequestHeaderUpdate,
  StoredRequestHeader,
} from './request-header.js';
import type { TlsCertificatePolicy } from './tls.js';
import type { HttpMonitorMethod, HttpRequestBody, HttpStatusPolicy } from './monitor.js';
import type { WorkspaceSecretReferenceV1 } from './workspace-secret-reference.js';

export const API_WORKFLOW_LIMITS = {
  minimumSteps: 2,
  maximumSteps: 10,
  maximumExtractionsPerStep: 16,
  maximumInitialVariables: 32,
  maximumVariables: 64,
  maximumVariableNameLength: 64,
  maximumVariableValueBytes: 16 * 1024,
  maximumExecutionMs: 90_000,
} as const;

export interface ApiWorkflowExtraction {
  variable: string;
  selector: string;
  sensitive: boolean;
}

type ApiWorkflowBodyType = Exclude<HttpRequestBody['type'], 'NONE'>;

export type ApiWorkflowRequestBodyUpdate =
  | HttpRequestBody
  | { type: ApiWorkflowBodyType; sensitive: true; retain: true }
  | {
      type: ApiWorkflowBodyType;
      sensitive: true;
      secretReference: WorkspaceSecretReferenceV1;
      contentType?: string;
    };

export type StoredApiWorkflowRequestBodyV1 =
  | { type: 'NONE' }
  | {
      type: ApiWorkflowBodyType;
      sensitive: true;
      encryptedValue: EncryptedHeaderValueV1;
    }
  | {
      type: ApiWorkflowBodyType;
      sensitive: true;
      secretReference: WorkspaceSecretReferenceV1;
      contentType?: string;
    };

interface ApiWorkflowStepBase<TRequestBody> {
  id: string;
  name: string;
  url: string;
  method: HttpMonitorMethod;
  timeoutMs: number;
  followRedirects: boolean;
  statusPolicy: HttpStatusPolicy;
  tlsPolicy: TlsCertificatePolicy;
  requestBody: TRequestBody;
  extractions: ApiWorkflowExtraction[];
}

export interface ApiWorkflowStepInput extends ApiWorkflowStepBase<ApiWorkflowRequestBodyUpdate> {
  requestHeaders: RequestHeaderUpdate[];
  assertions: unknown;
}

export interface ApiWorkflowConfigurationInput {
  contractVersion: 1;
  steps: ApiWorkflowStepInput[];
}

export interface StoredApiWorkflowStepV1 extends ApiWorkflowStepBase<StoredApiWorkflowRequestBodyV1> {
  requestHeaders: StoredRequestHeader[];
  assertions: ResponseAssertionConfigurationV1;
}

export interface StoredApiWorkflowConfigurationV1 {
  contractVersion: 1;
  steps: StoredApiWorkflowStepV1[];
}
