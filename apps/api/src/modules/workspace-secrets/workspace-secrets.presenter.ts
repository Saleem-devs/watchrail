import type { WorkspaceSecretAuditRecord, WorkspaceSecretRecord } from '@watchrail/db';

export function presentWorkspaceSecret(secret: WorkspaceSecretRecord) {
  return {
    id: secret.id,
    key: secret.key,
    description: secret.description,
    versionNumber: secret.versionNumber,
    usageCount: secret.usageCount,
    value: { hasValue: true as const },
    status: secret.archivedAt ? ('ARCHIVED' as const) : ('ACTIVE' as const),
    createdAt: secret.createdAt.toISOString(),
    updatedAt: secret.updatedAt.toISOString(),
    archivedAt: secret.archivedAt?.toISOString() ?? null,
  };
}

export function presentWorkspaceSecretAuditEvent(event: WorkspaceSecretAuditRecord) {
  return {
    id: event.id,
    actorId: event.actorId,
    action: event.action,
    versionNumber: event.versionNumber,
    occurredAt: event.occurredAt.toISOString(),
  };
}
