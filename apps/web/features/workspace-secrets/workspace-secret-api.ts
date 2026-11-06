import type {
  WorkspaceSecret,
  WorkspaceSecretApiError,
  WorkspaceSecretAuditEvent,
} from './workspace-secret-types';

export class WorkspaceSecretRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly details: WorkspaceSecretApiError,
  ) {
    super(message);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      Accept: 'application/json',
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      ...init?.headers,
    },
  });
  const body = (await response.json().catch(() => ({}))) as {
    data?: T;
    code?: string;
    message?: string;
    fields?: Record<string, string[]>;
  };
  if (!response.ok || body.data === undefined) {
    throw new WorkspaceSecretRequestError(
      body.message ?? 'The workspace secret request failed.',
      response.status,
      body,
    );
  }
  return body.data;
}

export function listWorkspaceSecrets(includeArchived = false): Promise<WorkspaceSecret[]> {
  const query = includeArchived ? '?includeArchived=true' : '';
  return request(`/api/workspace-secrets${query}`);
}

export function findWorkspaceSecret(secretId: string): Promise<WorkspaceSecret> {
  return request(`/api/workspace-secrets/${encodeURIComponent(secretId)}`);
}

export function createWorkspaceSecret(input: {
  key: string;
  description: string | null;
  value: string;
}): Promise<WorkspaceSecret> {
  return request('/api/workspace-secrets', { method: 'POST', body: JSON.stringify(input) });
}

export function updateWorkspaceSecretDescription(
  secretId: string,
  description: string | null,
): Promise<WorkspaceSecret> {
  return request(`/api/workspace-secrets/${encodeURIComponent(secretId)}`, {
    method: 'PATCH',
    body: JSON.stringify({ description }),
  });
}

export function rotateWorkspaceSecret(secretId: string, value: string): Promise<WorkspaceSecret> {
  return request(`/api/workspace-secrets/${encodeURIComponent(secretId)}/rotations`, {
    method: 'POST',
    body: JSON.stringify({ value }),
  });
}

export function archiveWorkspaceSecret(secretId: string): Promise<WorkspaceSecret> {
  return request(`/api/workspace-secrets/${encodeURIComponent(secretId)}`, { method: 'DELETE' });
}

export function listWorkspaceSecretAuditEvents(
  secretId: string,
): Promise<WorkspaceSecretAuditEvent[]> {
  return request(`/api/workspace-secrets/${encodeURIComponent(secretId)}/audit-events`);
}
