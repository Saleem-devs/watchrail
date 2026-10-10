export interface PublicStatusPageRateLimitOptions {
  clientCapacity: number;
  clientRefillPerSecond: number;
  globalCapacity: number;
  globalRefillPerSecond: number;
  clientTtlMs: number;
  sweepIntervalMs: number;
  maximumTrackedClients: number;
  maximumRetryAfterSeconds: number;
}

export const PUBLIC_STATUS_PAGE_RATE_LIMIT_DEFAULTS = {
  clientCapacity: 30,
  clientRefillPerSecond: 1,
  globalCapacity: 600,
  globalRefillPerSecond: 10,
  clientTtlMs: 5 * 60 * 1_000,
  sweepIntervalMs: 30 * 1_000,
  maximumTrackedClients: 10_000,
  maximumRetryAfterSeconds: 60,
} as const satisfies PublicStatusPageRateLimitOptions;

export type PublicStatusPageRateLimitResult =
  { allowed: true } | { allowed: false; retryAfterSeconds: number };

interface Bucket {
  tokens: number;
  lastRefillMs: number;
  lastSeenMs: number;
}

/**
 * Per-process MVP protection. The client map is TTL-evicted and hard-bounded;
 * excess identities share one overflow bucket instead of allocating memory.
 */
export class PublicStatusPageRateLimiter {
  private readonly clients = new Map<string, Bucket>();
  private readonly global: Bucket;
  private readonly overflow: Bucket;
  private lastSweepMs: number;
  private sweepCount = 0;

  constructor(
    private readonly options: PublicStatusPageRateLimitOptions = PUBLIC_STATUS_PAGE_RATE_LIMIT_DEFAULTS,
    private readonly now: () => number = () => performance.now(),
  ) {
    validateOptions(options);
    const timestamp = now();
    this.global = fullBucket(options.globalCapacity, timestamp);
    this.overflow = fullBucket(options.clientCapacity, timestamp);
    this.lastSweepMs = timestamp;
  }

  consume(clientId: string): PublicStatusPageRateLimitResult {
    const now = this.now();
    this.evictExpired(now);
    const globalResult = take(
      this.global,
      this.options.globalCapacity,
      this.options.globalRefillPerSecond,
      now,
      this.options.maximumRetryAfterSeconds,
    );
    if (!globalResult.allowed) return globalResult;

    let client = this.clients.get(clientId);
    if (!client) {
      if (this.clients.size < this.options.maximumTrackedClients) {
        client = fullBucket(this.options.clientCapacity, now);
        this.clients.set(clientId, client);
      } else {
        client = this.overflow;
      }
    }
    return take(
      client,
      this.options.clientCapacity,
      this.options.clientRefillPerSecond,
      now,
      this.options.maximumRetryAfterSeconds,
    );
  }

  get trackedClientCount(): number {
    return this.clients.size;
  }

  /** Identity-free diagnostic used to verify bounded cleanup cadence. */
  get completedSweepCount(): number {
    return this.sweepCount;
  }

  private evictExpired(now: number): void {
    if (now - this.lastSweepMs < this.options.sweepIntervalMs) return;
    for (const [clientId, bucket] of this.clients) {
      if (now - bucket.lastSeenMs >= this.options.clientTtlMs) this.clients.delete(clientId);
    }
    this.lastSweepMs = now;
    this.sweepCount += 1;
  }
}

function fullBucket(capacity: number, now: number): Bucket {
  return { tokens: capacity, lastRefillMs: now, lastSeenMs: now };
}

function take(
  bucket: Bucket,
  capacity: number,
  refillPerSecond: number,
  now: number,
  maximumRetryAfterSeconds: number,
): PublicStatusPageRateLimitResult {
  const elapsedMs = Math.max(0, now - bucket.lastRefillMs);
  bucket.tokens = Math.min(capacity, bucket.tokens + (elapsedMs / 1_000) * refillPerSecond);
  bucket.lastRefillMs = now;
  bucket.lastSeenMs = now;
  if (bucket.tokens >= 1) {
    bucket.tokens -= 1;
    return { allowed: true };
  }
  return {
    allowed: false,
    retryAfterSeconds: Math.max(
      1,
      Math.min(maximumRetryAfterSeconds, Math.ceil((1 - bucket.tokens) / refillPerSecond)),
    ),
  };
}

function validateOptions(options: PublicStatusPageRateLimitOptions): void {
  for (const [name, value] of Object.entries(options)) {
    if (!Number.isFinite(value) || value <= 0) {
      throw new RangeError(`${name} must be positive.`);
    }
  }
  if (!Number.isSafeInteger(options.clientCapacity))
    throw new RangeError('clientCapacity must be an integer.');
  if (!Number.isSafeInteger(options.globalCapacity))
    throw new RangeError('globalCapacity must be an integer.');
  if (!Number.isSafeInteger(options.maximumTrackedClients))
    throw new RangeError('maximumTrackedClients must be an integer.');
  if (!Number.isSafeInteger(options.maximumRetryAfterSeconds))
    throw new RangeError('maximumRetryAfterSeconds must be an integer.');
  if (!Number.isSafeInteger(options.clientTtlMs))
    throw new RangeError('clientTtlMs must be an integer.');
  if (!Number.isSafeInteger(options.sweepIntervalMs))
    throw new RangeError('sweepIntervalMs must be an integer.');
  if (options.sweepIntervalMs > options.clientTtlMs)
    throw new RangeError('sweepIntervalMs must not exceed clientTtlMs.');
}
