import { describe, expect, it, vi } from 'vitest';
import type { ClaimedEmailNotificationDelivery } from '@watchrail/db';
import {
  EmailNotificationWorker,
  type EmailNotificationDeliveryStore,
  type NotificationEmailSender,
} from './email-notification-worker.js';

const claim: ClaimedEmailNotificationDelivery = {
  id: '11111111-1111-4111-8111-111111111111',
  organizationId: '22222222-2222-4222-8222-222222222222',
  eventId: '33333333-3333-4333-8333-333333333333',
  monitorId: null,
  channelId: '44444444-4444-4444-8444-444444444444',
  channelVersionId: '55555555-5555-4555-8555-555555555555',
  recipientEmails: ['alerts@example.com'],
  payload: {
    contractVersion: 1,
    eventId: '33333333-3333-4333-8333-333333333333',
    eventType: 'TEST',
    occurredAt: '2026-11-06T12:00:00.000Z',
    organizationId: '22222222-2222-4222-8222-222222222222',
    channel: { id: '44444444-4444-4444-8444-444444444444', name: 'On-call' },
  },
  claimToken: 'claim-token',
  attemptCount: 1,
};

describe('EmailNotificationWorker', () => {
  it('renders and acknowledges a test notification', async () => {
    const fixture = setup();
    await expect(fixture.worker.processNext()).resolves.toBe('DELIVERED');
    expect(fixture.send).toHaveBeenCalledWith({
      to: ['alerts@example.com'],
      subject: 'Watchrail test notification — On-call',
      text: expect.stringContaining('No incident was created or changed.'),
    });
    expect(fixture.acknowledgeDelivered).toHaveBeenCalledWith(claim.id, 'claim-token');
  });

  it('suppresses incident mail before SMTP and retries transient SMTP failures', async () => {
    const suppressed = setup();
    suppressed.applyMaintenancePolicy.mockResolvedValue('SUPPRESSED');
    await expect(suppressed.worker.processNext()).resolves.toBe('SUPPRESSED');
    expect(suppressed.send).not.toHaveBeenCalled();

    const failed = setup();
    failed.send.mockRejectedValue(new Error('SMTP unavailable'));
    await expect(failed.worker.processNext()).resolves.toBe('RETRY_SCHEDULED');
    expect(failed.releaseForRetry).toHaveBeenCalledWith(
      claim.id,
      'claim-token',
      1_000,
      'SMTP_DELIVERY_FAILED',
    );
  });
});

function setup() {
  const claimNext = vi.fn(() => Promise.resolve(claim));
  const applyMaintenancePolicy = vi.fn(() =>
    Promise.resolve<'CONTINUE' | 'SUPPRESSED'>('CONTINUE'),
  );
  const acknowledgeDelivered = vi.fn(() => Promise.resolve(true));
  const releaseForRetry = vi.fn(() => Promise.resolve(true));
  const markDead = vi.fn(() => Promise.resolve(true));
  const store: EmailNotificationDeliveryStore = {
    claimNext,
    applyMaintenancePolicy,
    acknowledgeDelivered,
    releaseForRetry,
    markDead,
  };
  const send = vi.fn<NotificationEmailSender['send']>(() => Promise.resolve());
  return {
    worker: new EmailNotificationWorker(
      store,
      { send },
      {
        leaseDurationMs: 30_000,
        maxAttempts: 8,
        retryDelayMs: () => 1_000,
      },
    ),
    send,
    applyMaintenancePolicy,
    acknowledgeDelivered,
    releaseForRetry,
  };
}
