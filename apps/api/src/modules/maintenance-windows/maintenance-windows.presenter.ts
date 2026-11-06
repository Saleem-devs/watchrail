import type { MaintenanceWindowAuditRecord, MaintenanceWindowRecord } from '@watchrail/db';

export function presentMaintenanceWindow(window: MaintenanceWindowRecord) {
  return {
    id: window.id,
    projectId: window.projectId,
    versionNumber: window.versionNumber,
    name: window.name,
    schedule: window.schedule,
    target: window.target,
    effects: window.effects,
    effectiveAt: window.effectiveAt.toISOString(),
    archivedAt: window.archivedAt?.toISOString() ?? null,
    createdAt: window.createdAt.toISOString(),
    updatedAt: window.updatedAt.toISOString(),
  };
}

export function presentMaintenanceWindowAuditEvent(event: MaintenanceWindowAuditRecord) {
  return {
    id: event.id,
    action: event.action,
    versionNumber: event.versionNumber,
    actorId: event.actorId,
    occurredAt: event.occurredAt.toISOString(),
  };
}
