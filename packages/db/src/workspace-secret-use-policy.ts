import type { StoredApiWorkflowConfigurationV1, StoredRequestHeader } from '@watchrail/domain';

export class WorkspaceSecretUseAuthorizationError extends Error {
  constructor() {
    super('Permission to use workspace secrets is required for this operation.');
    this.name = 'WorkspaceSecretUseAuthorizationError';
  }
}

export function assertWorkspaceSecretUseAuthorized(
  configuration: {
    requestHeaders: readonly StoredRequestHeader[];
    apiWorkflow: StoredApiWorkflowConfigurationV1 | null;
  },
  authorized: boolean,
): void {
  if (authorized || !configurationUsesWorkspaceSecrets(configuration)) return;
  throw new WorkspaceSecretUseAuthorizationError();
}

function configurationUsesWorkspaceSecrets(configuration: {
  requestHeaders: readonly StoredRequestHeader[];
  apiWorkflow: StoredApiWorkflowConfigurationV1 | null;
}): boolean {
  return (
    configuration.requestHeaders.some((header) => 'secretReference' in header) ||
    configuration.apiWorkflow?.steps.some((step) =>
      step.requestHeaders.some((header) => 'secretReference' in header),
    ) === true
  );
}
