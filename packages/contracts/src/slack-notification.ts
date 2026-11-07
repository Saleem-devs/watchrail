import {
  InvalidWebhookNotificationError,
  parseWebhookNotification,
  type WebhookNotificationV1,
} from './webhook-notification.js';

export const SLACK_TEST_NOTIFICATION_CONTRACT_VERSION = 1;

export interface SlackTestNotificationV1 {
  contractVersion: typeof SLACK_TEST_NOTIFICATION_CONTRACT_VERSION;
  eventId: string;
  eventType: 'TEST';
  occurredAt: string;
  organizationId: string;
  channel: { id: string; name: string };
}

export type SlackNotificationV1 = WebhookNotificationV1 | SlackTestNotificationV1;

export class InvalidSlackNotificationError extends Error {
  constructor() {
    super('Slack-notification payload is invalid.');
    this.name = 'InvalidSlackNotificationError';
  }
}

export function createSlackTestNotification(input: {
  eventId: string;
  occurredAt: Date;
  organizationId: string;
  channel: { id: string; name: string };
}): SlackTestNotificationV1 {
  return parseSlackNotification({
    contractVersion: SLACK_TEST_NOTIFICATION_CONTRACT_VERSION,
    eventId: input.eventId,
    eventType: 'TEST',
    occurredAt: input.occurredAt.toISOString(),
    organizationId: input.organizationId,
    channel: input.channel,
  }) as SlackTestNotificationV1;
}

export function parseSlackNotification(value: unknown): SlackNotificationV1 {
  try {
    return parseWebhookNotification(value);
  } catch (error) {
    if (!(error instanceof InvalidWebhookNotificationError)) throw error;
  }
  if (
    !isExactRecord(value, [
      'contractVersion',
      'eventId',
      'eventType',
      'occurredAt',
      'organizationId',
      'channel',
    ]) ||
    value.contractVersion !== SLACK_TEST_NOTIFICATION_CONTRACT_VERSION ||
    value.eventType !== 'TEST' ||
    !isUuid(value.eventId) ||
    !isCanonicalTimestamp(value.occurredAt) ||
    !isUuid(value.organizationId) ||
    !isExactRecord(value.channel, ['id', 'name']) ||
    !isUuid(value.channel.id) ||
    typeof value.channel.name !== 'string' ||
    value.channel.name.trim().length === 0 ||
    value.channel.name.length > 120
  )
    throw new InvalidSlackNotificationError();
  return value as unknown as SlackTestNotificationV1;
}

function isExactRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isUuid(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)
  );
}

function isCanonicalTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
}
