export interface NotificationMonitor {
  id: string;
  name: string;
  type: 'HTTP' | 'TCP' | 'DNS' | 'API_WORKFLOW';
  lifecycleState: 'ENABLED' | 'PAUSED';
}

export interface WebhookChannel {
  id: string;
  projectId: string | null;
  name: string;
  url: string;
  enabled: boolean;
  versionNumber: number;
  signingSecret: { hasValue: true };
  routing: {
    monitorIds: string[];
    notifyOnIncident: boolean;
    notifyOnRecovery: boolean;
  };
  createdAt: string;
  updatedAt: string;
}

export type NotificationDeliveryStatus =
  'PENDING' | 'IN_FLIGHT' | 'RETRY_SCHEDULED' | 'DELIVERED' | 'DEAD';

export interface NotificationDelivery {
  id: string;
  event: {
    id: string;
    type: 'INCIDENT_OPENED' | 'INCIDENT_RESOLVED';
    occurredAt: string;
    monitorId: string;
    incidentId: string;
  };
  status: NotificationDeliveryStatus;
  attemptCount: number;
  lastAttemptAt: string | null;
  lastErrorCode: string | null;
  lastHttpStatus: number | null;
  nextAttemptAt: string | null;
  leaseExpiresAt: string | null;
  deliveredAt: string | null;
  deadAt: string | null;
  deadReason: string | null;
  createdAt: string;
}

export interface NotificationApiError {
  code?: string;
  message?: string;
  fields?: Record<string, string[]>;
}
