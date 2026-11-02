import { validateApiWorkflow, type ApiWorkflowInput } from '@watchrail/check-engine';
import {
  EMPTY_ASSERTION_CONFIGURATION,
  parseStoredApiWorkflowConfiguration,
  type ApiWorkflowConfigurationInput,
  type ApiWorkflowRequestBodyUpdate,
  type HttpRequestBody,
  type StoredApiWorkflowRequestBodyV1,
  type StoredApiWorkflowConfigurationV1,
} from '@watchrail/domain';
import {
  decryptHeaderValue,
  encryptHeaderValue,
  resolveRequestHeaders,
  storeRequestHeaders,
  type HeaderEncryptionKeyring,
} from '@watchrail/http-header-security';
import {
  resolveResponseAssertions,
  storeResponseAssertions,
  type AssertionEncryptionKeyring,
} from '@watchrail/assertion-security';

const WORKFLOW_REQUEST_BODY_ENCRYPTION_NAME = '@workflow-request-body';

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
      { ...context, normalizedHeaderName: WORKFLOW_REQUEST_BODY_ENCRYPTION_NAME },
      keyring,
    ),
  };
}

function resolveWorkflowRequestBody(
  stored: StoredApiWorkflowRequestBodyV1,
  context: ApiWorkflowEncryptionContext & { scope: string },
  keyring: HeaderEncryptionKeyring,
): HttpRequestBody {
  if (stored.type === 'NONE') return stored;
  const plaintext = decryptHeaderValue(
    stored.encryptedValue,
    { ...context, normalizedHeaderName: WORKFLOW_REQUEST_BODY_ENCRYPTION_NAME },
    keyring,
  );
  try {
    const resolved = JSON.parse(plaintext) as HttpRequestBody;
    if (resolved.type !== stored.type) throw new Error('Request-body type mismatch.');
    return resolved;
  } catch (error) {
    throw new ApiWorkflowConfigurationError('Stored workflow request body is invalid.', {
      cause: error,
    });
  }
}

function workflowStepScope(stepId: string): string {
  return `api-workflow-step:${stepId}`;
}
