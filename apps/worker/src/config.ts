export const WORKER_CONFIG = Symbol('WORKER_CONFIG');

export interface WorkerConfig {
  databaseUrl: string;
  redisUrl: string;
  queuePublicationTimeoutMs: number;
  checkConsumerConcurrency: number;
  checkExecutionLeaseDurationMs: number;
  checkWorkerLockDurationMs: number;
  outboxLeaseDurationMs: number;
  idlePollIntervalMs: number;
  dependencyErrorDelayMs: number;
  scheduleDispatchBatchSize: number;
  scheduleIdlePollIntervalMs: number;
  availabilityFlushBatchSize: number;
  availabilityFlushIntervalMs: number;
  headerEncryptionKeyring: HeaderEncryptionKeyring;
  assertionEncryptionKeyring: AssertionEncryptionKeyring;
  webhookSigningSecretKeyring: WebhookSigningSecretKeyring;
  webhookDeliveryTimeoutMs: number;
  webhookDeliveryLeaseDurationMs: number;
  webhookDeliveryMaxAttempts: number;
  webhookDeliveryRetryBaseMs: number;
  webhookDeliveryRetryMaxMs: number;
  webhookDeliveryConcurrency: number;
  webhookDeliveryIdlePollIntervalMs: number;
}

export function loadWorkerConfig(environment: NodeJS.ProcessEnv = process.env): WorkerConfig {
  const databaseUrl = requireUrl(environment.DATABASE_URL, 'DATABASE_URL', [
    'postgres:',
    'postgresql:',
  ]);
  const redisUrl = requireUrl(environment.REDIS_URL, 'REDIS_URL', ['redis:', 'rediss:']);
  const webhookDeliveryTimeoutMs = parsePositiveInteger(
    environment.WEBHOOK_DELIVERY_TIMEOUT_MS,
    'WEBHOOK_DELIVERY_TIMEOUT_MS',
    10_000,
  );
  const webhookDeliveryLeaseDurationMs = parsePositiveInteger(
    environment.WEBHOOK_DELIVERY_LEASE_DURATION_MS,
    'WEBHOOK_DELIVERY_LEASE_DURATION_MS',
    30_000,
  );
  if (webhookDeliveryLeaseDurationMs < webhookDeliveryTimeoutMs + 5_000)
    throw new Error(
      'WEBHOOK_DELIVERY_LEASE_DURATION_MS must exceed WEBHOOK_DELIVERY_TIMEOUT_MS by at least 5000.',
    );
  const webhookDeliveryRetryBaseMs = parsePositiveInteger(
    environment.WEBHOOK_DELIVERY_RETRY_BASE_MS,
    'WEBHOOK_DELIVERY_RETRY_BASE_MS',
    5_000,
  );
  const webhookDeliveryRetryMaxMs = parsePositiveInteger(
    environment.WEBHOOK_DELIVERY_RETRY_MAX_MS,
    'WEBHOOK_DELIVERY_RETRY_MAX_MS',
    300_000,
  );
  if (webhookDeliveryRetryBaseMs > webhookDeliveryRetryMaxMs)
    throw new Error('WEBHOOK_DELIVERY_RETRY_BASE_MS cannot exceed WEBHOOK_DELIVERY_RETRY_MAX_MS.');

  return {
    databaseUrl,
    redisUrl,
    queuePublicationTimeoutMs: parsePositiveInteger(
      environment.QUEUE_PUBLICATION_TIMEOUT_MS,
      'QUEUE_PUBLICATION_TIMEOUT_MS',
      2_000,
    ),
    checkConsumerConcurrency: parsePositiveInteger(
      environment.CHECK_CONSUMER_CONCURRENCY,
      'CHECK_CONSUMER_CONCURRENCY',
      5,
    ),
    checkExecutionLeaseDurationMs: parsePositiveInteger(
      environment.CHECK_EXECUTION_LEASE_DURATION_MS,
      'CHECK_EXECUTION_LEASE_DURATION_MS',
      45_000,
    ),
    checkWorkerLockDurationMs: parsePositiveInteger(
      environment.CHECK_WORKER_LOCK_DURATION_MS,
      'CHECK_WORKER_LOCK_DURATION_MS',
      30_000,
    ),
    outboxLeaseDurationMs: parsePositiveInteger(
      environment.OUTBOX_LEASE_DURATION_MS,
      'OUTBOX_LEASE_DURATION_MS',
      30_000,
    ),
    idlePollIntervalMs: parsePositiveInteger(
      environment.OUTBOX_IDLE_POLL_INTERVAL_MS,
      'OUTBOX_IDLE_POLL_INTERVAL_MS',
      500,
    ),
    dependencyErrorDelayMs: parsePositiveInteger(
      environment.OUTBOX_DEPENDENCY_ERROR_DELAY_MS,
      'OUTBOX_DEPENDENCY_ERROR_DELAY_MS',
      1_000,
    ),
    scheduleDispatchBatchSize: parseIntegerRange(
      environment.SCHEDULE_DISPATCH_BATCH_SIZE,
      'SCHEDULE_DISPATCH_BATCH_SIZE',
      100,
      1,
      1_000,
    ),
    scheduleIdlePollIntervalMs: parsePositiveInteger(
      environment.SCHEDULE_IDLE_POLL_INTERVAL_MS,
      'SCHEDULE_IDLE_POLL_INTERVAL_MS',
      1_000,
    ),
    availabilityFlushBatchSize: parseIntegerRange(
      environment.AVAILABILITY_FLUSH_BATCH_SIZE,
      'AVAILABILITY_FLUSH_BATCH_SIZE',
      100,
      1,
      1_000,
    ),
    availabilityFlushIntervalMs: parsePositiveInteger(
      environment.AVAILABILITY_FLUSH_INTERVAL_MS,
      'AVAILABILITY_FLUSH_INTERVAL_MS',
      60_000,
    ),
    headerEncryptionKeyring: loadHeaderEncryptionKeyring(environment),
    assertionEncryptionKeyring: loadAssertionEncryptionKeyring(environment),
    webhookSigningSecretKeyring: loadWebhookSigningSecretKeyring(environment),
    webhookDeliveryTimeoutMs,
    webhookDeliveryLeaseDurationMs,
    webhookDeliveryMaxAttempts: parseIntegerRange(
      environment.WEBHOOK_DELIVERY_MAX_ATTEMPTS,
      'WEBHOOK_DELIVERY_MAX_ATTEMPTS',
      8,
      1,
      100,
    ),
    webhookDeliveryRetryBaseMs,
    webhookDeliveryRetryMaxMs,
    webhookDeliveryConcurrency: parseIntegerRange(
      environment.WEBHOOK_DELIVERY_CONCURRENCY,
      'WEBHOOK_DELIVERY_CONCURRENCY',
      5,
      1,
      100,
    ),
    webhookDeliveryIdlePollIntervalMs: parsePositiveInteger(
      environment.WEBHOOK_DELIVERY_IDLE_POLL_INTERVAL_MS,
      'WEBHOOK_DELIVERY_IDLE_POLL_INTERVAL_MS',
      500,
    ),
  };
}

function parseIntegerRange(
  value: string | undefined,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}.`);
  }
  return parsed;
}

function requireUrl(value: string | undefined, name: string, protocols: string[]): string {
  if (!value) throw new Error(`${name} is required.`);

  let url: URL;

  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be a valid URL.`);
  }

  if (!protocols.includes(url.protocol)) {
    throw new Error(`${name} has an unsupported protocol.`);
  }

  return value;
}

function parsePositiveInteger(value: string | undefined, name: string, fallback: number): number {
  const parsed = value === undefined ? fallback : Number(value);

  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive safe integer.`);
  }

  return parsed;
}
import {
  loadHeaderEncryptionKeyring,
  type HeaderEncryptionKeyring,
} from '@watchrail/http-header-security';
import {
  loadAssertionEncryptionKeyring,
  type AssertionEncryptionKeyring,
} from '@watchrail/assertion-security';
import {
  loadWebhookSigningSecretKeyring,
  type WebhookSigningSecretKeyring,
} from '@watchrail/webhook-security';
