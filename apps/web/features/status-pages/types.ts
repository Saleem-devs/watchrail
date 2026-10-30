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
  };
}
