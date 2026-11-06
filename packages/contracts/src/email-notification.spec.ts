import { describe, expect, it } from 'vitest';
import {
  createEmailTestNotification,
  InvalidEmailNotificationError,
  parseEmailNotification,
} from './email-notification.js';
import { createWebhookNotification } from './webhook-notification.js';

const eventId = '11111111-1111-4111-8111-111111111111';
const organizationId = '22222222-2222-4222-8222-222222222222';
const channelId = '33333333-3333-4333-8333-333333333333';

describe('email notification contracts', () => {
  it('accepts incident payloads and creates exact test payloads', () => {
    const test = createEmailTestNotification({
      eventId,
      organizationId,
      occurredAt: new Date('2026-11-06T12:00:00.000Z'),
      channel: { id: channelId, name: 'On-call' },
    });
    expect(parseEmailNotification(test)).toEqual(test);
    expect(test).toEqual({
      contractVersion: 1,
      eventId,
      eventType: 'TEST',
      occurredAt: '2026-11-06T12:00:00.000Z',
      organizationId,
      channel: { id: channelId, name: 'On-call' },
    });

    expect(
      parseEmailNotification(
        createWebhookNotification({
          eventId,
          eventType: 'INCIDENT_OPENED',
          occurredAt: new Date('2026-11-06T12:00:00.000Z'),
          organizationId,
          monitor: { id: channelId, name: 'API' },
          incident: {
            id: '44444444-4444-4444-8444-444444444444',
            status: 'OPEN',
            startedAt: new Date('2026-11-06T11:59:00.000Z'),
            openedAt: new Date('2026-11-06T12:00:00.000Z'),
            resolvedAt: null,
          },
          triggeringRoundId: '55555555-5555-4555-8555-555555555555',
        }),
      ).eventType,
    ).toBe('INCIDENT_OPENED');
  });

  it.each([
    {},
    { contractVersion: 1, eventId, eventType: 'TEST' },
    {
      ...createEmailTestNotification({
        eventId,
        organizationId,
        occurredAt: new Date('2026-11-06T12:00:00.000Z'),
        channel: { id: channelId, name: 'On-call' },
      }),
      unexpected: true,
    },
  ])('rejects malformed payload %#', (value) =>
    expect(() => parseEmailNotification(value)).toThrow(InvalidEmailNotificationError),
  );
});
