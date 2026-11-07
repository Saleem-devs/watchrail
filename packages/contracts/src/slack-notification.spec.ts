import { describe, expect, it } from 'vitest';
import {
  createSlackTestNotification,
  InvalidSlackNotificationError,
  parseSlackNotification,
} from './slack-notification.js';

const testPayload = createSlackTestNotification({
  eventId: '11111111-1111-4111-8111-111111111111',
  occurredAt: new Date('2026-11-07T10:00:00.000Z'),
  organizationId: '22222222-2222-4222-8222-222222222222',
  channel: { id: '33333333-3333-4333-8333-333333333333', name: 'Operations Slack' },
});

describe('Slack notification contract', () => {
  it('round-trips a bounded test notification', () => {
    expect(parseSlackNotification(testPayload)).toEqual(testPayload);
  });

  it('rejects extra fields and invalid channel identities', () => {
    expect(() => parseSlackNotification({ ...testPayload, webhookUrl: 'secret' })).toThrow(
      InvalidSlackNotificationError,
    );
    expect(() =>
      parseSlackNotification({ ...testPayload, channel: { ...testPayload.channel, id: 'bad' } }),
    ).toThrow(InvalidSlackNotificationError);
  });
});
