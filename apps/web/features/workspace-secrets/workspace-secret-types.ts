export type WorkspaceSecretStatus = 'ACTIVE' | 'ARCHIVED';

export interface WorkspaceSecret {
  id: string;
  key: string;
  description: string | null;
  versionNumber: number;
  usageCount: number;
  value: { hasValue: true };
  status: WorkspaceSecretStatus;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
}

export type WorkspaceSecretAuditAction = 'CREATED' | 'DESCRIPTION_UPDATED' | 'ROTATED' | 'ARCHIVED';

export interface WorkspaceSecretAuditEvent {
  id: string;
  actorId: string;
  action: WorkspaceSecretAuditAction;
  versionNumber: number;
  occurredAt: string;
}

export interface WorkspaceSecretApiError {
  code?: string;
  message?: string;
  fields?: Record<string, string[]>;
}
