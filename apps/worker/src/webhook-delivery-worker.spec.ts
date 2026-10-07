import { describe, expect, it, vi } from 'vitest';
import type { ClaimedNotificationDelivery } from '@watchrail/db';
import {
  encryptWebhookSigningSecret,
  signWebhookBody,
  type WebhookSigningSecretKeyring,
} from '@watchrail/webhook-security';
import {
  WebhookDeliveryWorker,
  type NotificationDeliveryStore,
  type WebhookDeliveryAttemptExecutor,
} from './webhook-delivery-worker.js';

const organizationId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const endpointId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const eventId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const deliveryId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const keyring: WebhookSigningSecretKeyring = {
  activeKeyId: 'v1',
  keys: new Map([['v1', Buffer.alloc(32, 7)]]),
};
const signingSecret = 'watchrail-signing-secret-value-123456';

describe('WebhookDeliveryWorker', () => {
  it('signs and sends one exact serialization with stable attempt headers', async () => {
    const { store, acknowledgeDelivered } = storeReturning(claim());
    let sentBody: Uint8Array | undefined;
    const engine: WebhookDeliveryAttemptExecutor = {
      deliver(input) {
        sentBody = input.body;
        const headers = new Map(input.headers.map((header) => [header.name, header.value]));
        expect(headers.get('x-watchrail-event-id')).toBe(eventId);
        expect(headers.get('x-watchrail-delivery-id')).toBe(deliveryId);
        expect(headers.get('x-watchrail-timestamp')).toBe('1800000000');
        expect(headers.get('x-watchrail-signature')).toBe(
          signWebhookBody(signingSecret, 1_800_000_000, input.body),
        );
        return Promise.resolve({ type: 'HTTP', statusCode: 204 });
      },
    };
    const worker = createWorker(store, engine);
    await expect(worker.processNext()).resolves.toBe('DELIVERED');
    expect(Buffer.from(sentBody!).toString('utf8')).toBe(JSON.stringify(claim().payload));
    expect(acknowledgeDelivered).toHaveBeenCalledWith(deliveryId, 'claim-token', 204);
  });

  it.each([408, 425, 429, 500, 503])('retries HTTP %s', async (statusCode) => {
    const { store, releaseForRetry } = storeReturning(claim());
    const worker = createWorker(store, engineResult({ type: 'HTTP', statusCode }));
    await expect(worker.processNext()).resolves.toBe('RETRY_SCHEDULED');
    expect(releaseForRetry).toHaveBeenCalledWith(
      deliveryId,
      'claim-token',
      1234,
      `HTTP_${statusCode}`,
      statusCode,
    );
  });

  it.each([300, 302, 400, 401, 404, 422])('dead-letters HTTP %s', async (statusCode) => {
    const { store, markDead } = storeReturning(claim());
    const worker = createWorker(store, engineResult({ type: 'HTTP', statusCode }));
    await expect(worker.processNext()).resolves.toBe('DEAD');
    expect(markDead).toHaveBeenCalledWith(
      deliveryId,
      'claim-token',
      'PERMANENT_HTTP_STATUS',
      `HTTP_${statusCode}`,
      statusCode,
    );
  });

  it('keeps event and delivery identifiers stable across retry attempts', async () => {
    const fixture = storeReturning(claim());
    fixture.claimNext
      .mockResolvedValueOnce(claim())
      .mockResolvedValueOnce({ ...claim(), attemptCount: 2 });
    const deliver = vi
      .fn<WebhookDeliveryAttemptExecutor['deliver']>()
      .mockResolvedValueOnce({ type: 'FAILURE', errorCode: 'NETWORK_FAILURE', terminal: false })
      .mockResolvedValueOnce({ type: 'HTTP', statusCode: 204 });
    const worker = createWorker(fixture.store, { deliver });

    await expect(worker.processNext()).resolves.toBe('RETRY_SCHEDULED');
    await expect(worker.processNext()).resolves.toBe('DELIVERED');

    for (const [input] of deliver.mock.calls) {
      const headers = new Map(input.headers.map((header) => [header.name, header.value]));
      expect(headers.get('x-watchrail-event-id')).toBe(eventId);
      expect(headers.get('x-watchrail-delivery-id')).toBe(deliveryId);
    }
  });

  it('dead-letters malformed payloads and malformed or unauthentic secret envelopes', async () => {
    for (const [value, expected] of [
      [{ ...claim(), payload: { contractVersion: 99 } }, 'INVALID_CONTRACT'],
      [{ ...claim(), signingSecretEnvelope: { version: 1 } }, 'INVALID_SECRET_ENVELOPE'],
      [
        {
          ...claim(),
          signingSecretEnvelope: {
            ...(claim().signingSecretEnvelope as object),
            authTag: Buffer.alloc(16, 1).toString('base64url'),
          },
        },
        'INVALID_SECRET_ENVELOPE',
      ],
    ] as const) {
      const { store, markDead } = storeReturning(value);
      const worker = createWorker(store, engineResult({ type: 'HTTP', statusCode: 204 }));
      await expect(worker.processNext()).resolves.toBe('DEAD');
      expect(markDead).toHaveBeenCalledWith(
        deliveryId,
        'claim-token',
        expected,
        expected,
        undefined,
      );
    }
  });

  it('retries unavailable old keys and persists final cause on exhaustion', async () => {
    const unavailable = {
      ...claim(),
      signingSecretEnvelope: {
        ...(claim().signingSecretEnvelope as object),
        keyId: 'retired',
      },
    };
    const first = storeReturning(unavailable);
    await expect(
      createWorker(first.store, engineResult({ type: 'HTTP', statusCode: 204 })).processNext(),
    ).resolves.toBe('RETRY_SCHEDULED');
    expect(first.releaseForRetry).toHaveBeenCalledWith(
      deliveryId,
      'claim-token',
      1234,
      'SECRET_UNAVAILABLE',
      undefined,
    );

    const exhausted = storeReturning({ ...unavailable, attemptCount: 8 });
    await expect(
      createWorker(exhausted.store, engineResult({ type: 'HTTP', statusCode: 204 })).processNext(),
    ).resolves.toBe('DEAD');
    expect(exhausted.markDead).toHaveBeenCalledWith(
      deliveryId,
      'claim-token',
      'MAX_ATTEMPTS',
      'SECRET_UNAVAILABLE',
      undefined,
    );
  });

  it('retries network/timeouts, dead-letters policy failures, and reports lost claims', async () => {
    for (const errorCode of ['NETWORK_FAILURE', 'REQUEST_TIMEOUT'] as const) {
      const fixture = storeReturning(claim());
      await expect(
        createWorker(
          fixture.store,
          engineResult({ type: 'FAILURE', errorCode, terminal: false }),
        ).processNext(),
      ).resolves.toBe('RETRY_SCHEDULED');
    }
    for (const errorCode of ['PROHIBITED_DESTINATION', 'INVALID_TARGET'] as const) {
      const fixture = storeReturning(claim());
      await expect(
        createWorker(
          fixture.store,
          engineResult({ type: 'FAILURE', errorCode, terminal: true }),
        ).processNext(),
      ).resolves.toBe('DEAD');
    }
    const lost = storeReturning(claim(), false);
    await expect(
      createWorker(lost.store, engineResult({ type: 'HTTP', statusCode: 204 })).processNext(),
    ).resolves.toBe('LOST_CLAIM');
  });

  it('returns IDLE without invoking the engine when no delivery is available', async () => {
    const fixture = storeReturning(null);
    const engine = engineResult({ type: 'HTTP', statusCode: 204 });
    await expect(createWorker(fixture.store, engine).processNext()).resolves.toBe('IDLE');
    const { deliver } = engine;
    expect(deliver).not.toHaveBeenCalled();
  });
});

function claim(): ClaimedNotificationDelivery {
  return {
    id: deliveryId,
    organizationId,
    eventId,
    endpointId,
    endpointVersionId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
    endpointVersionNumber: 1,
    url: 'https://hooks.example.com/events',
    payload: {
      contractVersion: 1,
      eventId,
      eventType: 'INCIDENT_OPENED',
      occurredAt: '2026-10-07T00:00:00.000Z',
      organizationId,
      monitor: { id: '11111111-1111-4111-8111-111111111111', name: 'Payments' },
      incident: {
        id: '22222222-2222-4222-8222-222222222222',
        status: 'OPEN',
        startedAt: '2026-10-06T23:58:00.000Z',
        openedAt: '2026-10-07T00:00:00.000Z',
        resolvedAt: null,
      },
      triggeringRoundId: '33333333-3333-4333-8333-333333333333',
    },
    signingSecretEnvelope: encryptWebhookSigningSecret(
      signingSecret,
      { organizationId, endpointId, versionNumber: 1 },
      keyring,
    ),
    claimToken: 'claim-token',
    attemptCount: 1,
    lastAttemptAt: new Date(),
  };
}

function storeReturning(delivery: ClaimedNotificationDelivery | null, mutationResult = true) {
  const claimNext = vi.fn(() => Promise.resolve(delivery));
  const acknowledgeDelivered = vi.fn(() => Promise.resolve(mutationResult));
  const releaseForRetry = vi.fn(() => Promise.resolve(mutationResult));
  const markDead = vi.fn(() => Promise.resolve(mutationResult));
  const store: NotificationDeliveryStore = {
    claimNext,
    acknowledgeDelivered,
    releaseForRetry,
    markDead,
  };
  return { store, claimNext, acknowledgeDelivered, releaseForRetry, markDead };
}

function engineResult(
  result: Awaited<ReturnType<WebhookDeliveryAttemptExecutor['deliver']>>,
): WebhookDeliveryAttemptExecutor & { deliver: ReturnType<typeof vi.fn> } {
  return { deliver: vi.fn(() => Promise.resolve(result)) };
}

function createWorker(store: NotificationDeliveryStore, engine: WebhookDeliveryAttemptExecutor) {
  return new WebhookDeliveryWorker(store, engine, keyring, {
    leaseDurationMs: 30_000,
    timeoutMs: 10_000,
    maxAttempts: 8,
    retryDelayMs: () => 1234,
    now: () => new Date(1_800_000_000_000),
  });
}
