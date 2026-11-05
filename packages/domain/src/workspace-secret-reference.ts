export interface WorkspaceSecretReferenceV1 {
  contractVersion: 1;
  secretId: string;
}

export class WorkspaceSecretReferenceInputError extends Error {
  constructor() {
    super('Workspace secret reference is invalid.');
    this.name = 'WorkspaceSecretReferenceInputError';
  }
}

export function parseWorkspaceSecretReference(value: unknown): WorkspaceSecretReferenceV1 {
  if (
    !isRecord(value) ||
    Object.keys(value).length !== 2 ||
    value.contractVersion !== 1 ||
    typeof value.secretId !== 'string' ||
    !UUID.test(value.secretId)
  ) {
    throw new WorkspaceSecretReferenceInputError();
  }
  return { contractVersion: 1, secretId: value.secretId };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
