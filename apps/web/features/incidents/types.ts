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
}

export interface WorkspaceIncidentPage {
  items: WorkspaceIncident[];
  number: number;
  limit: number;
  total: number;
  totalPages: number;
}
