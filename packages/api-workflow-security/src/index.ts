import type { ApiWorkflowInput } from '@watchrail/check-engine';
import { parseStoredApiWorkflowConfiguration, type HttpRequestBody } from '@watchrail/domain';
import {
  decryptHeaderValue,
  resolveRequestHeaders,
  resolveRequestHeadersWithWorkspaceSecrets,
  type HeaderEncryptionKeyring,
  type WorkspaceSecretValueResolver,
} from '@watchrail/http-header-security';
import {
  resolveResponseAssertions,
  type AssertionEncryptionKeyring,
} from '@watchrail/assertion-security';

export const API_WORKFLOW_REQUEST_BODY_ENCRYPTION_NAME = '@workflow-request-body';

export interface ApiWorkflowEncryptionContext {
  organizationId: string;
  monitorId: string;
}

export interface ApiWorkflowKeyrings {
  headers: HeaderEncryptionKeyring;
  assertions: AssertionEncryptionKeyring;
}

export class ApiWorkflowResolutionError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ApiWorkflowResolutionError';
  }
}

export function resolveApiWorkflowConfiguration(
  value: unknown,
  context: ApiWorkflowEncryptionContext,
  keyrings: ApiWorkflowKeyrings,
  resolveWorkspaceSecret?: (secretId: string) => string,
): ApiWorkflowInput {
  const stored = parseStoredApiWorkflowConfiguration(value);
  return {
    steps: stored.steps.map((step) => {
      const scope = workflowStepScope(step.id);
      const assertions = resolveResponseAssertions(
        step.assertions,
        step.method,
        { ...context, scope },
        keyrings.assertions,
      );
      return {
        id: step.id,
        name: step.name,
        url: step.url,
        method: step.method,
        timeoutMs: step.timeoutMs,
        followRedirects: step.followRedirects,
        statusPolicy: step.statusPolicy,
        tlsPolicy: step.tlsPolicy,
        requestHeaders: resolveRequestHeaders(
          step.requestHeaders,
          { ...context, scope },
          keyrings.headers,
          resolveWorkspaceSecret,
        ),
        requestBody: resolveWorkflowRequestBody(
          step.requestBody,
          { ...context, scope },
          keyrings.headers,
        ),
        headerAssertions: assertions.headers,
        textBodyAssertions: assertions.textBody,
        jsonBodyAssertions: assertions.jsonBody,
        extractions: step.extractions,
      };
    }),
  };
}

export async function resolveApiWorkflowConfigurationWithWorkspaceSecrets(
  value: unknown,
  context: ApiWorkflowEncryptionContext,
  keyrings: ApiWorkflowKeyrings,
  resolveWorkspaceSecret: WorkspaceSecretValueResolver,
): Promise<ApiWorkflowInput> {
  const stored = parseStoredApiWorkflowConfiguration(value);
  return {
    steps: await Promise.all(
      stored.steps.map(async (step) => {
        const scope = workflowStepScope(step.id);
        const assertions = resolveResponseAssertions(
          step.assertions,
          step.method,
          { ...context, scope },
          keyrings.assertions,
        );
        return {
          id: step.id,
          name: step.name,
          url: step.url,
          method: step.method,
          timeoutMs: step.timeoutMs,
          followRedirects: step.followRedirects,
          statusPolicy: step.statusPolicy,
          tlsPolicy: step.tlsPolicy,
          requestHeaders: await resolveRequestHeadersWithWorkspaceSecrets(
            step.requestHeaders,
            { ...context, scope },
            keyrings.headers,
            resolveWorkspaceSecret,
          ),
          requestBody: resolveWorkflowRequestBody(
            step.requestBody,
            { ...context, scope },
            keyrings.headers,
          ),
          headerAssertions: assertions.headers,
          textBodyAssertions: assertions.textBody,
          jsonBodyAssertions: assertions.jsonBody,
          extractions: step.extractions,
        };
      }),
    ),
  };
}

function resolveWorkflowRequestBody(
  stored: ReturnType<typeof parseStoredApiWorkflowConfiguration>['steps'][number]['requestBody'],
  context: ApiWorkflowEncryptionContext & { scope: string },
  keyring: HeaderEncryptionKeyring,
): HttpRequestBody {
  if (stored.type === 'NONE') return stored;
  const plaintext = decryptHeaderValue(
    stored.encryptedValue,
    { ...context, normalizedHeaderName: API_WORKFLOW_REQUEST_BODY_ENCRYPTION_NAME },
    keyring,
  );
  try {
    const resolved = JSON.parse(plaintext) as HttpRequestBody;
    if (resolved.type !== stored.type) throw new Error('Request-body type mismatch.');
    return resolved;
  } catch (error) {
    throw new ApiWorkflowResolutionError('Stored workflow request body is invalid.', {
      cause: error,
    });
  }
}

function workflowStepScope(stepId: string): string {
  return `api-workflow-step:${stepId}`;
}
