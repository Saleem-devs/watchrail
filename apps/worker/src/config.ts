export const WORKER_CONFIG = Symbol('WORKER_CONFIG');

export interface WorkerConfig {
  databaseUrl: string;
  redisUrl: string;
  queuePublicationTimeoutMs: number;
  outboxLeaseDurationMs: number;
  idlePollIntervalMs: number;
  dependencyErrorDelayMs: number;
}

export function loadWorkerConfig(environment: NodeJS.ProcessEnv = process.env): WorkerConfig {
  const databaseUrl = requireUrl(environment.DATABASE_URL, 'DATABASE_URL', [
    'postgres:',
    'postgresql:',
  ]);
  const redisUrl = requireUrl(environment.REDIS_URL, 'REDIS_URL', ['redis:', 'rediss:']);

  return {
    databaseUrl,
    redisUrl,
    queuePublicationTimeoutMs: parsePositiveInteger(
      environment.QUEUE_PUBLICATION_TIMEOUT_MS,
      'QUEUE_PUBLICATION_TIMEOUT_MS',
      2_000,
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
  };
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
