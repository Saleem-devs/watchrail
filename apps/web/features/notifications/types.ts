export interface NotificationMonitor {
  id: string;
  name: string;
  type: 'HTTP' | 'TCP' | 'DNS' | 'API_WORKFLOW';
  lifecycleState: 'ENABLED' | 'PAUSED';
}

export interface WebhookChannel {
  type?: 'WEBHOOK';
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

export interface EmailChannel {
  id: string;
  projectId: string;
  type: 'EMAIL';
  name: string;
  enabled: boolean;
  versionNumber: number;
  recipientEmails: string[];
  routing: WebhookChannel['routing'];
  createdAt: string;
  updatedAt: string;
}

export type NotificationChannel = (WebhookChannel & { type: 'WEBHOOK' }) | EmailChannel;

export type NotificationDeliveryStatus =
  'PENDING' | 'IN_FLIGHT' | 'RETRY_SCHEDULED' | 'DELIVERED' | 'SUPPRESSED' | 'DEAD';

export interface NotificationDelivery {
  id: string;
  event: {
    id: string;
    type: 'INCIDENT_OPENED' | 'INCIDENT_RESOLVED' | 'TEST';
    occurredAt: string;
    monitorId: string | null;
    incidentId: string | null;
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
  suppressedAt: string | null;
  suppressionReason: string | null;
  createdAt: string;
}

export interface NotificationApiError {
  code?: string;
  message?: string;
  fields?: Record<string, string[]>;
}
