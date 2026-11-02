import { validateApiWorkflow, type ApiWorkflowInput } from '@watchrail/check-engine';
import {
  EMPTY_ASSERTION_CONFIGURATION,
  parseStoredApiWorkflowConfiguration,
  type ApiWorkflowConfigurationInput,
  type StoredApiWorkflowConfigurationV1,
} from '@watchrail/domain';
import {
  resolveRequestHeaders,
  storeRequestHeaders,
  type HeaderEncryptionKeyring,
} from '@watchrail/http-header-security';
import {
  resolveResponseAssertions,
  storeResponseAssertions,
  type AssertionEncryptionKeyring,
} from '@watchrail/assertion-security';

export interface ApiWorkflowEncryptionContext {
  organizationId: string;
  monitorId: string;
}

interface ApiWorkflowKeyrings {
  headers: HeaderEncryptionKeyring;
  assertions: AssertionEncryptionKeyring;
}

export class ApiWorkflowConfigurationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ApiWorkflowConfigurationError';
  }
}

export function storeApiWorkflowConfiguration(
  input: ApiWorkflowConfigurationInput,
  existingValue: unknown,
  context: ApiWorkflowEncryptionContext,
  keyrings: ApiWorkflowKeyrings,
  options: { allowRetain: boolean },
): StoredApiWorkflowConfigurationV1 {
  const existing =
    existingValue === null || existingValue === undefined
      ? null
      : parseStoredApiWorkflowConfiguration(existingValue);
  const existingById = new Map(existing?.steps.map((step) => [step.id, step]) ?? []);
  const stored: StoredApiWorkflowConfigurationV1 = {
    contractVersion: 1,
    steps: input.steps.map((step) => {
      const previous = existingById.get(step.id);
      const scope = workflowStepScope(step.id);
      return {
        ...step,
        requestHeaders: storeRequestHeaders(
          step.requestHeaders,
          previous?.requestHeaders ?? [],
          { ...context, scope },
          keyrings.headers,
        ),
        assertions: storeResponseAssertions(
          step.assertions,
          previous?.assertions ?? EMPTY_ASSERTION_CONFIGURATION,
          step.method,
          { ...context, scope },
          keyrings.assertions,
          options,
        ),
      };
    }),
  };
  const parsed = parseStoredApiWorkflowConfiguration(stored);
  try {
    validateApiWorkflow(resolveApiWorkflowConfiguration(parsed, context, keyrings));
  } catch (error) {
    if (error instanceof TypeError || error instanceof RangeError) {
      throw new ApiWorkflowConfigurationError(error.message, { cause: error });
    }
    throw error;
  }
  return parsed;
}

export function resolveApiWorkflowConfiguration(
  value: unknown,
  context: ApiWorkflowEncryptionContext,
  keyrings: ApiWorkflowKeyrings,
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
        ),
        requestBody: step.requestBody,
        headerAssertions: assertions.headers,
        textBodyAssertions: assertions.textBody,
        jsonBodyAssertions: assertions.jsonBody,
        extractions: step.extractions,
      };
    }),
  };
}

function workflowStepScope(stepId: string): string {
  return `api-workflow-step:${stepId}`;
}
