import type { WebhookDeliveryDetail, WebhookEndpointRecord } from '@watchrail/db';
import { describe, expect, it } from 'vitest';
import {
  presentWebhookDeliveryDetail,
  presentWebhookEndpoint,
} from './webhook-endpoints.presenter.js';

describe('webhook endpoint presenters', () => {
  it('allow-lists endpoint fields without organization identity or secrets', () => {
    const endpoint = {
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      organizationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      name: 'Operations',
      url: 'https://hooks.example.com/watchrail',
      enabled: true,
      versionNumber: 2,
      createdAt: new Date('2026-10-19T00:00:00.000Z'),
      updatedAt: new Date('2026-10-19T00:01:00.000Z'),
    } satisfies WebhookEndpointRecord;
    expect(presentWebhookEndpoint(endpoint)).toEqual({
      id: endpoint.id,
      name: endpoint.name,
      url: endpoint.url,
      enabled: true,
      versionNumber: 2,
      signingSecret: { hasValue: true },
      createdAt: '2026-10-19T00:00:00.000Z',
      updatedAt: '2026-10-19T00:01:00.000Z',
    });
    expect(presentWebhookEndpoint(endpoint)).not.toHaveProperty('organizationId');
  });

  it('serializes delivery detail with an explicit allow-list', () => {
    const delivery = {
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      event: {
        id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
        type: 'INCIDENT_OPENED',
        occurredAt: new Date('2026-10-19T00:00:00.000Z'),
        monitorId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        incidentId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      },
      status: 'DELIVERED',
      attemptCount: 1,
      lastAttemptAt: new Date('2026-10-19T00:00:02.000Z'),
      lastErrorCode: null,
      lastHttpStatus: 200,
      nextAttemptAt: null,
      leaseExpiresAt: null,
      deliveredAt: new Date('2026-10-19T00:00:03.000Z'),
      deadAt: null,
      deadReason: null,
      createdAt: new Date('2026-10-19T00:00:01.000Z'),
      endpointId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      endpointVersion: {
        id: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
        versionNumber: 1,
        url: 'https://hooks.example.com/watchrail',
      },
      triggeringRoundId: '99999999-9999-4999-8999-999999999999',
    } satisfies WebhookDeliveryDetail;
    expect(presentWebhookDeliveryDetail(delivery)).toEqual({
      ...delivery,
      event: { ...delivery.event, occurredAt: '2026-10-19T00:00:00.000Z' },
      lastAttemptAt: '2026-10-19T00:00:02.000Z',
      deliveredAt: '2026-10-19T00:00:03.000Z',
      createdAt: '2026-10-19T00:00:01.000Z',
    });
  });
});
