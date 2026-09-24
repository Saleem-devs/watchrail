import { describe, expect, it } from 'vitest';
import { loadWorkerConfig } from './config.js';

const requiredEnvironment = {
  DATABASE_URL: 'postgresql://watchrail:watchrail@localhost:5433/watchrail',
  REDIS_URL: 'redis://localhost:6379',
};

describe('loadWorkerConfig', () => {
  it('loads explicit dependencies and safe relay defaults', () => {
    expect(loadWorkerConfig(requiredEnvironment)).toEqual({
      databaseUrl: requiredEnvironment.DATABASE_URL,
      redisUrl: requiredEnvironment.REDIS_URL,
      queuePublicationTimeoutMs: 2_000,
      checkConsumerConcurrency: 5,
      checkExecutionLeaseDurationMs: 45_000,
      checkWorkerLockDurationMs: 30_000,
      outboxLeaseDurationMs: 30_000,
      idlePollIntervalMs: 500,
      dependencyErrorDelayMs: 1_000,
    });
  });

  it.each([
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
  ])('rejects invalid environment %#', (environment, message) => {
    expect(() => loadWorkerConfig(environment)).toThrow(message);
  });
});
