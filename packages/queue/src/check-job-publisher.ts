import { Queue } from 'bullmq';
import { createClient } from 'redis';
import {
  CHECK_EXECUTION_QUEUE,
  checkRoundJobId,
  EXECUTE_CHECK_ROUND_JOB,
  parseExecuteCheckRoundJob,
} from '@watchrail/contracts';
import type { ExecuteCheckRoundJobV1 } from '@watchrail/contracts';

const COMPLETED_JOB_RETENTION_SECONDS = 60 * 60;
const FAILED_JOB_RETENTION_SECONDS = 24 * 60 * 60;

type CheckExecutionQueue = Queue<ExecuteCheckRoundJobV1, void, typeof EXECUTE_CHECK_ROUND_JOB>;

export interface CheckJobPublisher {
  publish(payload: ExecuteCheckRoundJobV1): Promise<void>;
}

export interface BullMqCheckJobPublisherOptions {
  redisUrl: string;
  connectTimeoutMs?: number;
  publicationTimeoutMs?: number;
  onRedisError?: (error: Error) => void;
}

export class CheckQueueUnavailableError extends Error {
  constructor() {
    super('The check queue Redis connection is unavailable.');
    this.name = 'CheckQueueUnavailableError';
  }
}

export class CheckQueuePublicationTimeoutError extends Error {
  constructor() {
    super('Publishing the check job exceeded its deadline.');
    this.name = 'CheckQueuePublicationTimeoutError';
  }
}

export class BullMqCheckJobPublisher implements CheckJobPublisher {
  private constructor(
    private readonly queue: CheckExecutionQueue,
    private readonly isRedisReady: () => boolean,
    private readonly publicationTimeoutMs: number,
    private readonly closeRedis: () => Promise<void>,
  ) {}

  static async connect(options: BullMqCheckJobPublisherOptions): Promise<BullMqCheckJobPublisher> {
    const connectTimeoutMs = options.connectTimeoutMs ?? 2_000;
    const publicationTimeoutMs = options.publicationTimeoutMs ?? 2_000;
    assertPositiveMilliseconds(connectTimeoutMs, 'connectTimeoutMs');
    assertPositiveMilliseconds(publicationTimeoutMs, 'publicationTimeoutMs');

    const redis = createClient({
      url: options.redisUrl,
      disableOfflineQueue: true,
      socket: {
        connectTimeout: connectTimeoutMs,
        reconnectStrategy: (retries) => Math.min(100 * 2 ** Math.min(retries, 4), 2_000),
      },
    });

    redis.on('error', (error: unknown) => {
      options.onRedisError?.(error instanceof Error ? error : new Error('Unknown Redis error.'));
    });
    await connectWithin(redis, connectTimeoutMs);

    const queue = new Queue<ExecuteCheckRoundJobV1, void, typeof EXECUTE_CHECK_ROUND_JOB>(
      CHECK_EXECUTION_QUEUE,
      {
        connection: redis,
        skipWaitingForReady: true,
        defaultJobOptions: {
          removeOnComplete: { age: COMPLETED_JOB_RETENTION_SECONDS },
          removeOnFail: { age: FAILED_JOB_RETENTION_SECONDS },
        },
      },
    );

    return new BullMqCheckJobPublisher(
      queue,
      () => redis.isReady,
      publicationTimeoutMs,
      async () => {
        if (redis.isOpen) await redis.close();
      },
    );
  }

  async publish(payload: ExecuteCheckRoundJobV1): Promise<void> {
    const validated = parseExecuteCheckRoundJob(payload);

    if (!this.isRedisReady()) throw new CheckQueueUnavailableError();

    await completeWithin(
      this.queue.add(EXECUTE_CHECK_ROUND_JOB, validated, {
        jobId: checkRoundJobId(validated.roundId),
      }),
      this.publicationTimeoutMs,
      () => new CheckQueuePublicationTimeoutError(),
    );
  }

  async close(): Promise<void> {
    await this.queue.close();
    await this.closeRedis();
  }
}

function assertPositiveMilliseconds(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive safe integer.`);
  }
}

interface ManagedRedisConnection {
  connect(): Promise<unknown>;
  destroy(): void;
}

async function connectWithin(redis: ManagedRedisConnection, deadlineMs: number): Promise<void> {
  try {
    await completeWithin(
      redis.connect(),
      deadlineMs,
      () => new Error('Redis connection deadline exceeded.'),
    );
  } catch (error) {
    redis.destroy();
    throw error;
  }
}

async function completeWithin<T>(
  operation: Promise<T>,
  deadlineMs: number,
  createTimeoutError: () => Error,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;

  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(createTimeoutError()), deadlineMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
