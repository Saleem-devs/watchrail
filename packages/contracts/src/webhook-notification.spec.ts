import { describe, expect, it } from 'vitest';
import {
  createWebhookNotification,
  InvalidWebhookNotificationError,
  parseWebhookNotification,
} from './webhook-notification.js';

const ids = {
  eventId: '11111111-1111-4111-8111-111111111111',
  organizationId: '22222222-2222-4222-8222-222222222222',
  monitorId: '33333333-3333-4333-8333-333333333333',
  incidentId: '44444444-4444-4444-8444-444444444444',
  roundId: '55555555-5555-4555-8555-555555555555',
};
const opened = {
  eventId: ids.eventId,
  eventType: 'INCIDENT_OPENED' as const,
  occurredAt: new Date('2026-10-05T12:00:00.123Z'),
  organizationId: ids.organizationId,
  monitor: { id: ids.monitorId, name: 'Public API' },
  incident: {
    id: ids.incidentId,
    status: 'OPEN' as const,
    startedAt: new Date('2026-10-05T11:58:00.000Z'),
    openedAt: new Date('2026-10-05T12:00:00.123Z'),
    resolvedAt: null,
  },
  triggeringRoundId: ids.roundId,
};

describe('webhook notification V1', () => {
  it('creates an exact immutable OPENED payload without URL or diagnostics', () => {
    const value = createWebhookNotification(opened);
    expect(parseWebhookNotification(value)).toEqual(value);
    expect(value).toEqual({
      contractVersion: 1,
      eventId: ids.eventId,
      eventType: 'INCIDENT_OPENED',
      occurredAt: '2026-10-05T12:00:00.123Z',
      organizationId: ids.organizationId,
      monitor: { id: ids.monitorId, name: 'Public API' },
      incident: {
        id: ids.incidentId,
        status: 'OPEN',
        startedAt: '2026-10-05T11:58:00.000Z',
        openedAt: '2026-10-05T12:00:00.123Z',
        resolvedAt: null,
      },
      triggeringRoundId: ids.roundId,
    });
    expect(JSON.stringify(value)).not.toMatch(/url|response|uptime|failure/i);
  });
  it('creates a consistent RESOLVED payload', () => {
    const resolvedAt = new Date('2026-10-05T12:05:00.000Z');
    expect(
      createWebhookNotification({
        ...opened,
        eventType: 'INCIDENT_RESOLVED',
        occurredAt: resolvedAt,
        incident: { ...opened.incident, status: 'RESOLVED', resolvedAt },
      }),
    ).toMatchObject({
      eventType: 'INCIDENT_RESOLVED',
      occurredAt: resolvedAt.toISOString(),
      incident: { status: 'RESOLVED', resolvedAt: resolvedAt.toISOString() },
    });
  });
  it.each([
    null,
    [],
    {},
    { ...createWebhookNotification(opened), unexpected: true },
    { ...createWebhookNotification(opened), contractVersion: 2 },
    { ...createWebhookNotification(opened), occurredAt: '2026-10-05T12:00:00.123+00:00' },
    {
      ...createWebhookNotification(opened),
      monitor: { id: ids.monitorId, name: 'Public API', url: 'secret' },
    },
    {
      ...createWebhookNotification(opened),
      incident: { ...createWebhookNotification(opened).incident, status: 'RESOLVED' },
    },
    {
      ...createWebhookNotification(opened),
      incident: {
        ...createWebhookNotification(opened).incident,
        resolvedAt: '2026-10-05T12:05:00.000Z',
      },
    },
  ])('rejects malformed or inconsistent payload %#', (value) =>
    expect(() => parseWebhookNotification(value)).toThrow(InvalidWebhookNotificationError),
  );
});
