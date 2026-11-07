import { describe, expect, it, vi } from 'vitest';
import type { ClaimedSlackNotificationDelivery } from '@watchrail/db';
import { encryptSlackWebhookUrl } from '@watchrail/webhook-security';
import {
  renderSlackMessage,
  SlackNotificationWorker,
  type SlackDeliveryAttemptExecutor,
  type SlackDeliveryStore,
} from './slack-notification-worker.js';

const ids = {
  delivery: '11111111-1111-4111-8111-111111111111',
  organization: '22222222-2222-4222-8222-222222222222',
  event: '33333333-3333-4333-8333-333333333333',
  channel: '44444444-4444-4444-8444-444444444444',
  version: '55555555-5555-4555-8555-555555555555',
};
const keyring = {
  activeKeyId: 'slack-test',
  keys: new Map([['slack-test', Buffer.alloc(32, 7)]]),
};
const webhookUrl = [
  'https://hooks.slack.com',
  'services',
  'T00000000',
  'B00000000',
  'XXXXXXXXXXXXXXXXXXXXXXXX',
].join('/');
const claim: ClaimedSlackNotificationDelivery = {
  id: ids.delivery,
  organizationId: ids.organization,
  eventId: ids.event,
  monitorId: null,
  channelId: ids.channel,
  channelVersionId: ids.version,
  channelVersionNumber: 1,
  webhookUrlEnvelope: encryptSlackWebhookUrl(
    webhookUrl,
    { organizationId: ids.organization, channelId: ids.channel, versionNumber: 1 },
    keyring,
  ),
  payload: {
    contractVersion: 1,
    eventId: ids.event,
    eventType: 'TEST',
    occurredAt: '2026-11-07T10:00:00.000Z',
    organizationId: ids.organization,
    channel: { id: ids.channel, name: 'Operations <alerts>' },
  },
  claimToken: 'claim-token',
  attemptCount: 1,
};

describe('SlackNotificationWorker', () => {
  it('decrypts the retained webhook, renders safe blocks, and acknowledges delivery', async () => {
    const fixture = setup();
    await expect(fixture.worker.processNext()).resolves.toBe('DELIVERED');
    expect(fixture.deliver).toHaveBeenCalledWith(
      expect.objectContaining({
        url: webhookUrl,
        timeoutMs: 10_000,
        headers: [{ name: 'content-type', value: 'application/json; charset=utf-8' }],
      }),
    );
    const request = fixture.deliver.mock.calls[0]![0];
    const body = JSON.parse(Buffer.from(request.body).toString('utf8')) as { blocks: unknown[] };
    expect(JSON.stringify(body)).toContain('Operations &lt;alerts&gt;');
    expect(JSON.stringify(body)).not.toContain('hooks.slack.com');
    expect(fixture.acknowledgeDelivered).toHaveBeenCalledWith(ids.delivery, 'claim-token', 200);
  });

  it('uses the remaining lease budget and reschedules before sending when it is exhausted', async () => {
    const bounded = setup();
    bounded.applyMaintenancePolicy.mockResolvedValue({
      state: 'CONTINUE',
      databaseNow: new Date('2026-11-07T10:00:22.000Z'),
      leaseExpiresAt: new Date('2026-11-07T10:00:30.000Z'),
    });
    await expect(bounded.worker.processNext()).resolves.toBe('DELIVERED');
    expect(bounded.deliver).toHaveBeenCalledWith(expect.objectContaining({ timeoutMs: 3_000 }));

    const exhausted = setup();
    exhausted.applyMaintenancePolicy.mockResolvedValue({
      state: 'CONTINUE',
      databaseNow: new Date('2026-11-07T10:00:25.000Z'),
      leaseExpiresAt: new Date('2026-11-07T10:00:30.000Z'),
    });
    await expect(exhausted.worker.processNext()).resolves.toBe('RETRY_SCHEDULED');
    expect(exhausted.deliver).not.toHaveBeenCalled();
    expect(exhausted.releaseForRetry).toHaveBeenCalledWith(
      ids.delivery,
      'claim-token',
      1_000,
      'LEASE_BUDGET_EXHAUSTED',
      undefined,
    );
  });

  it('subtracts pre-dispatch work from the lease budget and reschedules when it is exhausted', async () => {
    const monotonicNowMs = vi.fn().mockReturnValueOnce(1_000).mockReturnValueOnce(4_001);
    const fixture = setup({ monotonicNowMs });
    fixture.applyMaintenancePolicy.mockResolvedValue({
      state: 'CONTINUE',
      databaseNow: new Date('2026-11-07T10:00:22.000Z'),
      leaseExpiresAt: new Date('2026-11-07T10:00:30.000Z'),
    });

    await expect(fixture.worker.processNext()).resolves.toBe('RETRY_SCHEDULED');
    expect(fixture.deliver).not.toHaveBeenCalled();
    expect(fixture.releaseForRetry).toHaveBeenCalledWith(
      ids.delivery,
      'claim-token',
      1_000,
      'LEASE_BUDGET_EXHAUSTED',
      undefined,
    );
  });

  it('retries transient Slack responses and dead-letters permanent responses', async () => {
    const retry = setup();
    retry.deliver.mockResolvedValue({ type: 'HTTP', statusCode: 429 });
    await expect(retry.worker.processNext()).resolves.toBe('RETRY_SCHEDULED');
    expect(retry.releaseForRetry).toHaveBeenCalledWith(
      ids.delivery,
      'claim-token',
      1_000,
      'HTTP_429',
      429,
    );

    const dead = setup();
    dead.deliver.mockResolvedValue({ type: 'HTTP', statusCode: 400 });
    await expect(dead.worker.processNext()).resolves.toBe('DEAD');
    expect(dead.markDead).toHaveBeenCalledWith(
      ids.delivery,
      'claim-token',
      'PERMANENT_HTTP_STATUS',
      'HTTP_400',
      400,
    );
  });

  it('renders incident text without interpreting Slack markup from monitor names', () => {
    const message = renderSlackMessage({
      contractVersion: 2,
      eventId: ids.event,
      eventType: 'INCIDENT_OPENED',
      occurredAt: '2026-11-07T10:00:00.000Z',
      organizationId: ids.organization,
      monitor: { id: '77777777-7777-4777-8777-777777777777', name: '<!channel> API' },
      incident: {
        id: '88888888-8888-4888-8888-888888888888',
        groupKey: 'availability:77777777-7777-4777-8777-777777777777',
        severity: 'DEGRADED',
        status: 'OPEN',
        startedAt: '2026-11-07T10:00:00.000Z',
        openedAt: '2026-11-07T10:00:00.000Z',
        resolvedAt: null,
      },
      triggeringRoundId: '99999999-9999-4999-8999-999999999999',
    });
    expect(JSON.stringify(message.blocks)).toContain('&lt;!channel&gt; API');
    expect(JSON.stringify(message.blocks)).not.toContain('<!channel> API');
    expect(JSON.stringify(message.blocks)).toContain('*Impact*\\nDegraded');
    expect(JSON.stringify(message.blocks)).toContain(
      'availability:77777777-7777-4777-8777-777777777777',
    );
    expect(message.text).toBe('Incident opened: &lt;!channel&gt; API');
  });
});

function setup({ monotonicNowMs = () => 0 }: { monotonicNowMs?: () => number } = {}) {
  const claimNext = vi.fn(() => Promise.resolve(claim));
  const applyMaintenancePolicy = vi.fn<SlackDeliveryStore['applyMaintenancePolicy']>(() =>
    Promise.resolve({
      state: 'CONTINUE',
      databaseNow: new Date('2026-11-07T10:00:00.000Z'),
      leaseExpiresAt: new Date('2026-11-07T10:00:30.000Z'),
    }),
  );
  const acknowledgeDelivered = vi.fn(() => Promise.resolve(true));
  const releaseForRetry = vi.fn(() => Promise.resolve(true));
  const markDead = vi.fn(() => Promise.resolve(true));
  const deliver = vi.fn<SlackDeliveryAttemptExecutor['deliver']>(() =>
    Promise.resolve({ type: 'HTTP', statusCode: 200 }),
  );
  return {
    worker: new SlackNotificationWorker(
      { claimNext, applyMaintenancePolicy, acknowledgeDelivered, releaseForRetry, markDead },
      { deliver },
      keyring,
      {
        leaseDurationMs: 30_000,
        sendTimeoutMs: 10_000,
        maxAttempts: 8,
        retryDelayMs: () => 1_000,
        monotonicNowMs,
      },
    ),
    deliver,
    applyMaintenancePolicy,
    acknowledgeDelivered,
    releaseForRetry,
    markDead,
  };
}
