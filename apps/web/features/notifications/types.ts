export interface NotificationMonitor {
  id: string;
  name: string;
  type:
    'HTTP' | 'TCP' | 'DNS' | 'ICMP' | 'API_WORKFLOW' | 'HEARTBEAT' | 'DOMAIN_EXPIRY' | 'KEYWORD';
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
    allMonitors?: boolean;
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

export interface SlackChannel {
  id: string;
  projectId: string;
  type: 'SLACK';
  name: string;
  enabled: boolean;
  versionNumber: number;
  webhookUrl: { hasValue: true };
  routing: WebhookChannel['routing'];
  createdAt: string;
  updatedAt: string;
}

export type NotificationChannel =
  (WebhookChannel & { type: 'WEBHOOK' }) | EmailChannel | SlackChannel;

export type NotificationDeliveryStatus =
  'PENDING' | 'IN_FLIGHT' | 'RETRY_SCHEDULED' | 'DELIVERED' | 'SUPPRESSED' | 'DEAD';

export interface NotificationDelivery {
  id: string;
  deliverySequence: number;
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

export interface IncidentEscalationStep {
  delayMinutes: number;
  channelIds: string[] | null;
}

export interface IncidentEscalationPolicy {
  steps: IncidentEscalationStep[];
}
