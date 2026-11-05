import { validateApiWorkflow } from '@watchrail/check-engine';
import {
  resolveApiWorkflowConfiguration,
  API_WORKFLOW_REQUEST_BODY_ENCRYPTION_NAME,
  type ApiWorkflowEncryptionContext,
  type ApiWorkflowKeyrings,
} from '@watchrail/api-workflow-security';
import {
  EMPTY_ASSERTION_CONFIGURATION,
  parseStoredApiWorkflowConfiguration,
  type ApiWorkflowConfigurationInput,
  type ApiWorkflowRequestBodyUpdate,
  type StoredApiWorkflowRequestBodyV1,
  type StoredApiWorkflowConfigurationV1,
} from '@watchrail/domain';
import {
  encryptHeaderValue,
  storeRequestHeaders,
  type HeaderEncryptionKeyring,
} from '@watchrail/http-header-security';
import { storeResponseAssertions } from '@watchrail/assertion-security';

export { resolveApiWorkflowConfiguration } from '@watchrail/api-workflow-security';
export type { ApiWorkflowEncryptionContext } from '@watchrail/api-workflow-security';

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
  if (!options.allowRetain) assertNoCreationRetention(input);
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
        requestBody: storeWorkflowRequestBody(
          step.requestBody,
          previous?.requestBody ?? { type: 'NONE' },
          { ...context, scope },
          keyrings.headers,
          options,
        ),
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
    validateApiWorkflow(
      resolveApiWorkflowConfiguration(parsed, context, keyrings, () => 'workspace-secret'),
    );
  } catch (error) {
    if (error instanceof TypeError || error instanceof RangeError) {
      throw new ApiWorkflowConfigurationError(error.message, { cause: error });
    }
    throw error;
  }
  return parsed;
}

function assertNoCreationRetention(input: ApiWorkflowConfigurationInput): void {
  for (const step of input.steps) {
    if (step.requestHeaders.some((header) => 'retain' in header)) {
      throw new ApiWorkflowConfigurationError(
        'Cannot retain workflow header secrets during monitor creation.',
      );
    }
    if ('retain' in step.requestBody) {
      throw new ApiWorkflowConfigurationError(
        'Cannot retain a workflow request body during monitor creation.',
      );
    }
  }
}

function storeWorkflowRequestBody(
  update: ApiWorkflowRequestBodyUpdate,
  existing: StoredApiWorkflowRequestBodyV1,
  context: ApiWorkflowEncryptionContext & { scope: string },
  keyring: HeaderEncryptionKeyring,
  options: { allowRetain: boolean },
): StoredApiWorkflowRequestBodyV1 {
  if (update.type === 'NONE') return update;
  if ('retain' in update) {
    if (!options.allowRetain) {
      throw new ApiWorkflowConfigurationError(
        'Cannot retain a workflow request body during monitor creation.',
      );
    }
    if (existing.type !== update.type || !('encryptedValue' in existing)) {
      throw new ApiWorkflowConfigurationError(
        `Cannot retain the missing ${update.type.toLowerCase()} workflow request body.`,
      );
    }
    return existing;
  }
  return {
    type: update.type,
    sensitive: true,
    encryptedValue: encryptHeaderValue(
      JSON.stringify(update),
      { ...context, normalizedHeaderName: API_WORKFLOW_REQUEST_BODY_ENCRYPTION_NAME },
      keyring,
    ),
  };
}

function workflowStepScope(stepId: string): string {
  return `api-workflow-step:${stepId}`;
}
