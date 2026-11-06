export type MaintenanceWindowSchedule =
  | { type: 'ONE_TIME'; startsAt: string; endsAt: string }
  | {
      type: 'RECURRING';
      timezone: string;
      localTime: string;
      daysOfWeek: number[];
      durationMinutes: number;
      startsOn: string;
      endsOn: string | null;
    };

export interface MaintenanceWindowEffects {
  suppressNotifications: boolean;
  suppressIncidentCreation: boolean;
  excludeFromUptime: boolean;
  publishToStatusPage: boolean;
}

export interface MaintenanceWindow {
  id: string;
  projectId: string;
  versionNumber: number;
  name: string;
  schedule: MaintenanceWindowSchedule;
  target: { type: 'PROJECT' } | { type: 'MONITORS'; monitorIds: string[] };
  effects: MaintenanceWindowEffects;
  effectiveAt: string;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface MaintenanceMonitor {
  id: string;
  name: string;
  type: 'HTTP' | 'TCP' | 'DNS' | 'API_WORKFLOW' | 'HEARTBEAT';
  lifecycleState: 'ENABLED' | 'PAUSED';
}

export interface MaintenanceWindowAuditEvent {
  id: string;
  action: 'CREATED' | 'UPDATED' | 'ARCHIVED';
  versionNumber: number;
  actorId: string;
  occurredAt: string;
}

export interface MaintenanceApiError {
  code?: string;
  message?: string;
  fields?: Record<string, string[]>;
}
