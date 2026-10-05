import { describe, expect, it } from 'vitest';
import { loadWorkerConfig } from './config.js';

const requiredEnvironment = {
  DATABASE_URL: 'postgresql://watchrail:watchrail@localhost:5433/watchrail',
  REDIS_URL: 'redis://localhost:6379',
  HTTP_HEADER_ACTIVE_KEY_ID: 'test',
  HTTP_HEADER_ENCRYPTION_KEYS: JSON.stringify({ test: Buffer.alloc(32).toString('base64') }),
  ASSERTION_ACTIVE_KEY_ID: 'test',
  ASSERTION_ENCRYPTION_KEYS: JSON.stringify({ test: Buffer.alloc(32).toString('base64') }),
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
    });
  });

  it.each([
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
