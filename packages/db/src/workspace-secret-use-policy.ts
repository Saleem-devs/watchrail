import type {
  ResponseAssertionConfigurationV1,
  StoredApiWorkflowConfigurationV1,
  StoredHeaderAssertion,
  StoredJsonBodyAssertion,
  StoredRequestHeader,
  StoredTextBodyAssertion,
} from '@watchrail/domain';

export class WorkspaceSecretUseAuthorizationError extends Error {
  constructor() {
    super('Permission to use workspace secrets is required for this operation.');
    this.name = 'WorkspaceSecretUseAuthorizationError';
  }
}

export function assertWorkspaceSecretUseAuthorized(
  configuration: {
    requestHeaders: readonly StoredRequestHeader[];
    assertions: ResponseAssertionConfigurationV1;
    apiWorkflow: StoredApiWorkflowConfigurationV1 | null;
  },
  authorized: boolean,
): void {
  if (authorized || !configurationUsesWorkspaceSecrets(configuration)) return;
  throw new WorkspaceSecretUseAuthorizationError();
}

function configurationUsesWorkspaceSecrets(configuration: {
  requestHeaders: readonly StoredRequestHeader[];
  assertions: ResponseAssertionConfigurationV1;
  apiWorkflow: StoredApiWorkflowConfigurationV1 | null;
}): boolean {
  return (
    configuration.requestHeaders.some((header) => 'secretReference' in header) ||
    assertionConfigurationUsesWorkspaceSecrets(configuration.assertions) ||
    configuration.apiWorkflow?.steps.some(
      (step) =>
        (step.requestBody.type !== 'NONE' && 'secretReference' in step.requestBody) ||
        step.requestHeaders.some((header) => 'secretReference' in header) ||
        assertionConfigurationUsesWorkspaceSecrets(step.assertions),
    ) === true
  );
}

function assertionConfigurationUsesWorkspaceSecrets(
  configuration: ResponseAssertionConfigurationV1,
): boolean {
  const groups: ReadonlyArray<
    readonly (StoredHeaderAssertion | StoredTextBodyAssertion | StoredJsonBodyAssertion)[]
  > = [
    configuration.assertions.headers,
    configuration.assertions.textBody,
    configuration.assertions.jsonBody,
  ];
  return groups.some((assertions) =>
    assertions.some((assertion) => 'target' in assertion && 'secretReference' in assertion.target),
  );
}
