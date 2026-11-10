export interface WorkspaceStatusPage {
  id: string;
  projectId?: string;
  name: string;
  logoUrl: string | null;
  slug: string;
  published: boolean;
  components: Array<{
    id: string;
    displayName: string;
    groupName: string | null;
    monitorId: string;
    position: number;
  }>;
  createdAt: string;
  updatedAt: string;
}

export interface StatusPageMonitor {
  id: string;
  name: string;
  url: string;
  type: 'HTTP' | 'TCP' | 'DNS' | 'ICMP' | 'API_WORKFLOW';
  configuration:
    | { type: 'HTTP'; url: string }
    | { type: 'TCP'; host: string; port: number }
    | { type: 'ICMP'; host: string }
    | { type: 'DNS'; name: string; recordType: string; expectedValues: string[] }
    | { type: 'API_WORKFLOW'; workflow: { steps: Array<{ name: string; url: string }> } };
  lifecycleState: 'ENABLED' | 'PAUSED';
  currentCheck: {
    availability: 'AVAILABLE' | 'UNAVAILABLE' | 'UNKNOWN';
    aggregateOutcome: 'UP' | 'DEGRADED' | 'DOWN' | 'UNKNOWN' | null;
  } | null;
}

export interface StatusPageComponentDraft {
  monitorId: string;
  displayName: string;
  groupName: string;
}

export interface StatusPageApiError {
  message?: string;
  fields?: {
    statusPage?: string[];
    components?: string[];
    componentIds?: string[];
    incident?: string[];
  };
}

export type StatusPageIncidentState = 'INVESTIGATING' | 'IDENTIFIED' | 'MONITORING' | 'RESOLVED';

export interface WorkspaceStatusPageIncident {
  id: string;
  statusPageId: string;
  title: string;
  impact: 'DEGRADED' | 'DOWN';
  state: StatusPageIncidentState;
  startedAt: string;
  resolvedAt: string | null;
  updatedAt: string;
  components: Array<{ id: string; displayName: string; position: number }>;
  updates: Array<{
    id: string;
    sequence: number;
    state: StatusPageIncidentState;
    message: string;
    createdByActorId: string;
    createdAt: string;
  }>;
}
