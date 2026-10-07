import { describe, expect, it } from 'vitest';
import { loadWorkerConfig } from './config.js';

const requiredEnvironment = {
  DATABASE_URL: 'postgresql://watchrail:watchrail@localhost:5433/watchrail',
  REDIS_URL: 'redis://localhost:6379',
  HTTP_HEADER_ACTIVE_KEY_ID: 'test',
  HTTP_HEADER_ENCRYPTION_KEYS: JSON.stringify({ test: Buffer.alloc(32).toString('base64') }),
  ASSERTION_ACTIVE_KEY_ID: 'test',
  ASSERTION_ENCRYPTION_KEYS: JSON.stringify({ test: Buffer.alloc(32).toString('base64') }),
  WEBHOOK_SIGNING_SECRET_ACTIVE_KEY_ID: 'test',
  WEBHOOK_SIGNING_SECRET_ENCRYPTION_KEYS: JSON.stringify({
    test: Buffer.alloc(32).toString('base64'),
  }),
};

describe('loadWorkerConfig', () => {
  it('loads explicit dependencies and safe relay defaults', () => {
    expect(loadWorkerConfig(requiredEnvironment)).toMatchObject({
      databaseUrl: requiredEnvironment.DATABASE_URL,
      redisUrl: requiredEnvironment.REDIS_URL,
      queuePublicationTimeoutMs: 2_000,
      checkConsumerConcurrency: 5,
      checkExecutionLeaseDurationMs: 45_000,
      checkWorkerLockDurationMs: 30_000,
      outboxLeaseDurationMs: 30_000,
      idlePollIntervalMs: 500,
      dependencyErrorDelayMs: 1_000,
      scheduleDispatchBatchSize: 100,
      scheduleIdlePollIntervalMs: 1_000,
      availabilityFlushBatchSize: 100,
      availabilityFlushIntervalMs: 60_000,
      headerEncryptionKeyring: { activeKeyId: 'test' },
      assertionEncryptionKeyring: { activeKeyId: 'test' },
      webhookSigningSecretKeyring: { activeKeyId: 'test' },
      webhookDeliveryTimeoutMs: 10_000,
      webhookDeliveryLeaseDurationMs: 30_000,
      webhookDeliveryMaxAttempts: 8,
      webhookDeliveryRetryBaseMs: 5_000,
      webhookDeliveryRetryMaxMs: 300_000,
      webhookDeliveryConcurrency: 5,
      webhookDeliveryIdlePollIntervalMs: 500,
    });
  });

  it.each([
    [
      {
        ...requiredEnvironment,
        WEBHOOK_DELIVERY_TIMEOUT_MS: '30000',
        WEBHOOK_DELIVERY_LEASE_DURATION_MS: '30000',
      },
      'WEBHOOK_DELIVERY_LEASE_DURATION_MS must exceed WEBHOOK_DELIVERY_TIMEOUT_MS by at least 5000.',
    ],
    [
      {
        ...requiredEnvironment,
        WEBHOOK_DELIVERY_RETRY_BASE_MS: '6000',
        WEBHOOK_DELIVERY_RETRY_MAX_MS: '5000',
      },
      'WEBHOOK_DELIVERY_RETRY_BASE_MS cannot exceed WEBHOOK_DELIVERY_RETRY_MAX_MS.',
    ],
    [
      { ...requiredEnvironment, WEBHOOK_DELIVERY_CONCURRENCY: '101' },
      'WEBHOOK_DELIVERY_CONCURRENCY must be an integer from 1 to 100.',
    ],
    [
      { ...requiredEnvironment, AVAILABILITY_FLUSH_BATCH_SIZE: '1001' },
      'AVAILABILITY_FLUSH_BATCH_SIZE must be an integer from 1 to 1000.',
    ],
    [
      { ...requiredEnvironment, AVAILABILITY_FLUSH_INTERVAL_MS: '0' },
      'AVAILABILITY_FLUSH_INTERVAL_MS must be a positive safe integer.',
    ],
    [{ REDIS_URL: requiredEnvironment.REDIS_URL }, 'DATABASE_URL is required.'],
    [{ DATABASE_URL: requiredEnvironment.DATABASE_URL }, 'REDIS_URL is required.'],
    [
      { ...requiredEnvironment, REDIS_URL: 'https://example.com' },
      'REDIS_URL has an unsupported protocol.',
    ],
    [
      { ...requiredEnvironment, OUTBOX_LEASE_DURATION_MS: '0' },
      'OUTBOX_LEASE_DURATION_MS must be a positive safe integer.',
    ],
    [
      { ...requiredEnvironment, QUEUE_PUBLICATION_TIMEOUT_MS: '1.5' },
      'QUEUE_PUBLICATION_TIMEOUT_MS must be a positive safe integer.',
    ],
    [
      { ...requiredEnvironment, CHECK_CONSUMER_CONCURRENCY: '0' },
      'CHECK_CONSUMER_CONCURRENCY must be a positive safe integer.',
    ],
    [
      { ...requiredEnvironment, SCHEDULE_DISPATCH_BATCH_SIZE: '1001' },
      'SCHEDULE_DISPATCH_BATCH_SIZE must be an integer from 1 to 1000.',
    ],
    [
      { ...requiredEnvironment, SCHEDULE_IDLE_POLL_INTERVAL_MS: '0' },
      'SCHEDULE_IDLE_POLL_INTERVAL_MS must be a positive safe integer.',
    ],
  ])('rejects invalid environment %#', (environment, message) => {
    expect(() => loadWorkerConfig(environment)).toThrow(message);
  });
});
