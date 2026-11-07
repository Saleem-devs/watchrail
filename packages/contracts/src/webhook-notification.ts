export const WEBHOOK_NOTIFICATION_CONTRACT_VERSION = 2;
export const NOTIFICATION_EVENT_TYPES = ['INCIDENT_OPENED', 'INCIDENT_RESOLVED'] as const;
export type NotificationEventType = (typeof NOTIFICATION_EVENT_TYPES)[number];
export type NotificationIncidentSeverity = 'DEGRADED' | 'DOWN';

interface WebhookNotificationBase {
  eventId: string;
  eventType: NotificationEventType;
  occurredAt: string;
  organizationId: string;
  monitor: { id: string; name: string };
  triggeringRoundId: string;
}

export interface WebhookNotificationV1 extends WebhookNotificationBase {
  contractVersion: 1;
  incident: {
    id: string;
    status: 'OPEN' | 'RESOLVED';
    startedAt: string;
    openedAt: string;
    resolvedAt: string | null;
  };
}

export interface WebhookNotificationV2 extends WebhookNotificationBase {
  contractVersion: typeof WEBHOOK_NOTIFICATION_CONTRACT_VERSION;
  incident: WebhookNotificationV1['incident'] & {
    groupKey: string;
    severity: NotificationIncidentSeverity;
  };
}

export type WebhookNotification = WebhookNotificationV1 | WebhookNotificationV2;

export interface CreateWebhookNotificationV2 {
  eventId: string;
  eventType: NotificationEventType;
  occurredAt: Date;
  organizationId: string;
  monitor: { id: string; name: string };
  incident: {
    id: string;
    groupKey: string;
    severity: NotificationIncidentSeverity;
    status: 'OPEN' | 'RESOLVED';
    startedAt: Date;
    openedAt: Date;
    resolvedAt: Date | null;
  };
  triggeringRoundId: string;
}

export class InvalidWebhookNotificationError extends Error {
  constructor() {
    super('Webhook-notification payload is invalid.');
    this.name = 'InvalidWebhookNotificationError';
  }
}

export function createWebhookNotification(
  input: CreateWebhookNotificationV2,
): WebhookNotificationV2 {
  return parseWebhookNotification({
    contractVersion: WEBHOOK_NOTIFICATION_CONTRACT_VERSION,
    ...input,
    occurredAt: serializeDate(input.occurredAt),
    incident: {
      ...input.incident,
      startedAt: serializeDate(input.incident.startedAt),
      openedAt: serializeDate(input.incident.openedAt),
      resolvedAt: input.incident.resolvedAt ? serializeDate(input.incident.resolvedAt) : null,
    },
  }) as WebhookNotificationV2;
}

export function parseWebhookNotification(value: unknown): WebhookNotification {
  if (
    !isExactRecord(value, [
      'contractVersion',
      'eventId',
      'eventType',
      'occurredAt',
      'organizationId',
      'monitor',
      'incident',
      'triggeringRoundId',
    ]) ||
    (value.contractVersion !== 1 &&
      value.contractVersion !== WEBHOOK_NOTIFICATION_CONTRACT_VERSION) ||
    !isUuid(value.eventId) ||
    !isEventType(value.eventType) ||
    !isCanonicalTimestamp(value.occurredAt) ||
    !isUuid(value.organizationId) ||
    !isExactRecord(value.monitor, ['id', 'name']) ||
    !isUuid(value.monitor.id) ||
    typeof value.monitor.name !== 'string' ||
    value.monitor.name.length === 0 ||
    value.monitor.name.length > 120 ||
    !isUuid(value.triggeringRoundId) ||
    !isIncident(value.incident, value.contractVersion)
  )
    invalid();
  const incident = value.incident;
  const opened = value.eventType === 'INCIDENT_OPENED';
  if (
    (opened && (incident.status !== 'OPEN' || incident.resolvedAt !== null)) ||
    (!opened && (incident.status !== 'RESOLVED' || !isCanonicalTimestamp(incident.resolvedAt))) ||
    Date.parse(incident.startedAt) > Date.parse(incident.openedAt) ||
    (incident.resolvedAt !== null &&
      Date.parse(incident.openedAt) > Date.parse(incident.resolvedAt)) ||
    value.occurredAt !== (opened ? incident.openedAt : incident.resolvedAt)
  )
    invalid();
  return value as unknown as WebhookNotification;
}

function isIncident(
  value: unknown,
  contractVersion: 1 | 2,
): value is WebhookNotification['incident'] {
  const keys =
    contractVersion === 1
      ? ['id', 'status', 'startedAt', 'openedAt', 'resolvedAt']
      : ['id', 'groupKey', 'severity', 'status', 'startedAt', 'openedAt', 'resolvedAt'];
  if (
    !isExactRecord(value, keys) ||
    !isUuid(value.id) ||
    (value.status !== 'OPEN' && value.status !== 'RESOLVED') ||
    !isCanonicalTimestamp(value.startedAt) ||
    !isCanonicalTimestamp(value.openedAt) ||
    (value.resolvedAt !== null && !isCanonicalTimestamp(value.resolvedAt))
  )
    return false;
  return contractVersion === 1 || isV2Incident(value);
}

function isV2Incident(value: Record<string, unknown>): value is WebhookNotificationV2['incident'] {
  return (
    typeof value.groupKey === 'string' &&
    /^availability:[0-9a-f-]{36}$/u.test(value.groupKey) &&
    (value.severity === 'DEGRADED' || value.severity === 'DOWN')
  );
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}
function isEventType(value: unknown): value is NotificationEventType {
  return (
    typeof value === 'string' && (NOTIFICATION_EVENT_TYPES as readonly string[]).includes(value)
  );
}
function isCanonicalTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
}
function serializeDate(value: Date): string {
  if (Number.isNaN(value.getTime())) invalid();
  return value.toISOString();
}
function isExactRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}
function invalid(): never {
  throw new InvalidWebhookNotificationError();
}
