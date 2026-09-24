import { describe, expect, it, vi } from 'vitest';
import type { ClaimedCheckRoundOutboxEvent } from '@watchrail/db';
import { CheckQueuePublicationTimeoutError, type CheckJobPublisher } from '@watchrail/queue';
import {
  CheckOutboxRelay,
  createExponentialBackoff,
  type CheckRoundOutboxStore,
} from './check-outbox-relay.js';

const event: ClaimedCheckRoundOutboxEvent = {
  id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  roundId: '11111111-1111-4111-8111-111111111111',
  payload: {
    contractVersion: 1,
    roundId: '11111111-1111-4111-8111-111111111111',
  },
  createdAt: new Date('2026-09-24T00:00:00.000Z'),
  availableAt: new Date('2026-09-24T00:00:30.000Z'),
  claimToken: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  attemptCount: 1,
  lastAttemptAt: new Date('2026-09-24T00:00:00.000Z'),
  lastErrorCode: null,
  blockedAt: null,
  blockedReason: null,
  publishedAt: null,
};

function createDependencies(overrides?: {
  event?: ClaimedCheckRoundOutboxEvent | null;
  publishError?: unknown;
  acknowledge?: boolean;
  release?: boolean;
  block?: boolean;
}) {
  const claimNext = vi
    .fn<CheckRoundOutboxStore['claimNext']>()
    .mockResolvedValue(overrides?.event === undefined ? event : overrides.event);
  const acknowledgePublished = vi
    .fn<CheckRoundOutboxStore['acknowledgePublished']>()
    .mockResolvedValue(overrides?.acknowledge ?? true);
  const releaseForRetry = vi
    .fn<CheckRoundOutboxStore['releaseForRetry']>()
    .mockResolvedValue(overrides?.release ?? true);
  const blockInvalid = vi
    .fn<CheckRoundOutboxStore['blockInvalid']>()
    .mockResolvedValue(overrides?.block ?? true);
  const outbox: CheckRoundOutboxStore = {
    claimNext,
    acknowledgePublished,
    releaseForRetry,
    blockInvalid,
  };

  const publish = vi.fn<CheckJobPublisher['publish']>();

  if (overrides?.publishError === undefined) publish.mockResolvedValue(undefined);
  else publish.mockRejectedValue(overrides.publishError);

  const publisher: CheckJobPublisher = { publish };
  const relay = new CheckOutboxRelay(outbox, publisher, {
    leaseDurationMs: 30_000,
    retryDelayMs: () => 5_000,
  });

  return { acknowledgePublished, blockInvalid, publish, relay, releaseForRetry };
}

describe('CheckOutboxRelay', () => {
  it('publishes and acknowledges a valid claimed event', async () => {
    const { acknowledgePublished, publish, relay } = createDependencies();

    await expect(relay.processNext()).resolves.toBe('PUBLISHED');
    expect(publish).toHaveBeenCalledWith(event.payload);
    expect(acknowledgePublished).toHaveBeenCalledWith(event.id, event.claimToken);
  });

  it('reports idle without touching the publisher', async () => {
    const { publish, relay } = createDependencies({ event: null });

    await expect(relay.processNext()).resolves.toBe('IDLE');
    expect(publish).not.toHaveBeenCalled();
  });

  it('blocks a malformed contract without publishing it', async () => {
    const { blockInvalid, publish, relay } = createDependencies({
      event: { ...event, payload: { contractVersion: 99 } },
    });

    await expect(relay.processNext()).resolves.toBe('BLOCKED_INVALID');
    expect(blockInvalid).toHaveBeenCalledWith(event.id, event.claimToken);
    expect(publish).not.toHaveBeenCalled();
  });

  it('releases publication failure with retry delay and stable code', async () => {
    const { relay, releaseForRetry } = createDependencies({
      publishError: new Error('Redis unavailable'),
    });

    await expect(relay.processNext()).resolves.toBe('RETRY_SCHEDULED');
    expect(releaseForRetry).toHaveBeenCalledWith(
      event.id,
      event.claimToken,
      5_000,
      'REDIS_UNAVAILABLE',
    );
  });

  it('records a queue publication deadline separately from Redis unavailability', async () => {
    const { relay, releaseForRetry } = createDependencies({
      publishError: new CheckQueuePublicationTimeoutError(),
    });

    await expect(relay.processNext()).resolves.toBe('RETRY_SCHEDULED');
    expect(releaseForRetry).toHaveBeenCalledWith(
      event.id,
      event.claimToken,
      5_000,
      'QUEUE_PUBLICATION_TIMEOUT',
    );
  });

  it.each([
    { acknowledge: false },
    { publishError: new Error('Redis unavailable'), release: false },
    { event: { ...event, payload: null }, block: false },
  ])('reports a lost claim when the fenced update is rejected', async (overrides) => {
    const { relay } = createDependencies(overrides);
    await expect(relay.processNext()).resolves.toBe('LOST_CLAIM');
  });
});

describe('createExponentialBackoff', () => {
  it('applies bounded exponential delay and jitter', () => {
    const backoff = createExponentialBackoff(1_000, 10_000, () => 0.5);

    expect([1, 2, 3, 4, 5].map(backoff)).toEqual([1_000, 2_000, 4_000, 8_000, 10_000]);
  });
});
