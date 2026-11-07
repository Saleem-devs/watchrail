export type IncidentStatusFilter = 'all' | 'open' | 'resolved';

export interface WorkspaceIncident {
  id: string;
  monitorId: string;
  monitorName: string;
  monitorUrl: string;
  status: 'OPEN' | 'RESOLVED';
  severity: 'DEGRADED' | 'DOWN' | null;
  startedAt: string;
  openedAt: string;
  resolvedAt: string | null;
  acknowledgedAt: string | null;
  acknowledgedByActorId: string | null;
  silencedAt: string | null;
  silencedUntil: string | null;
  notificationsSilenced: boolean;
  silencedByActorId: string | null;
  resolvedByActorId: string | null;
  resolutionNote: string | null;
}

export interface WorkspaceIncidentDetail extends WorkspaceIncident {
  projectId: string;
  startedByRoundId: string;
  openedByRoundId: string;
  resolvedByRoundId: string | null;
  createdAt: string;
}

export interface IncidentActionEvent {
  id: string;
  incidentId: string;
  actorId: string;
  action: 'ACKNOWLEDGED' | 'SILENCED' | 'UNSILENCED' | 'MANUALLY_RESOLVED';
  silenceUntil: string | null;
  note: string | null;
  occurredAt: string;
}

export interface WorkspaceIncidentPage {
  items: WorkspaceIncident[];
  number: number;
  limit: number;
  total: number;
  totalPages: number;
}
