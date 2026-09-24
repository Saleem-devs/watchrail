import { createNodeRedisClient, UnrecoverableError, Worker } from 'bullmq';
import { createClient } from 'redis';
import {
  CHECK_EXECUTION_QUEUE,
  EXECUTE_CHECK_ROUND_JOB,
  InvalidExecuteCheckRoundJobError,
  parseExecuteCheckRoundJob,
} from '@watchrail/contracts';
import type { ExecuteCheckRoundJobV1 } from '@watchrail/contracts';

export interface CheckJobHandler {
  handle(payload: ExecuteCheckRoundJobV1): Promise<void>;
}

export interface BullMqCheckJobConsumerOptions {
  redisUrl: string;
  handler: CheckJobHandler;
  concurrency?: number;
  connectTimeoutMs?: number;
  lockDurationMs?: number;
  onError?: (error: Error) => void;
}

type CheckExecutionWorker = Worker<unknown, void, string>;

export class BullMqCheckJobConsumer {
  private constructor(
    private readonly worker: CheckExecutionWorker,
    private readonly closeRedis: () => Promise<void>,
  ) {}

  static async connect(options: BullMqCheckJobConsumerOptions): Promise<BullMqCheckJobConsumer> {
    const concurrency = options.concurrency ?? 5;
    const connectTimeoutMs = options.connectTimeoutMs ?? 2_000;
    const lockDurationMs = options.lockDurationMs ?? 30_000;

    assertPositiveInteger(concurrency, 'concurrency');
    assertPositiveInteger(connectTimeoutMs, 'connectTimeoutMs');
    assertPositiveInteger(lockDurationMs, 'lockDurationMs');

    const redis = createClient({
      url: options.redisUrl,
      disableOfflineQueue: true,
      socket: {
        connectTimeout: connectTimeoutMs,
        reconnectStrategy: (retries) => Math.min(100 * 2 ** Math.min(retries, 4), 2_000),
      },
    });

    redis.on('error', (error: unknown) => {
      options.onError?.(error instanceof Error ? error : new Error('Unknown Redis error.'));
    });

    await connectWithin(redis, connectTimeoutMs);

    const worker = new Worker<unknown, void, string>(
      CHECK_EXECUTION_QUEUE,
      async (job) => {
        try {
          if (job.name !== EXECUTE_CHECK_ROUND_JOB) {
            throw new InvalidExecuteCheckRoundJobError();
          }

          await options.handler.handle(parseExecuteCheckRoundJob(job.data));
        } catch (error) {
          if (error instanceof InvalidExecuteCheckRoundJobError) {
            throw new UnrecoverableError(error.message);
          }

          throw error;
        }
      },
      {
        connection: createNodeRedisClient(redis),
        concurrency,
        lockDuration: lockDurationMs,
        skipWaitingForReady: true,
      },
    );

    worker.on('error', (error) => options.onError?.(error));

    try {
      await completeWithin(
        worker.waitUntilReady(),
        connectTimeoutMs,
        () => new Error('BullMQ worker connection deadline exceeded.'),
      );
    } catch (error) {
      await worker.close(true);
      if (redis.isOpen) redis.destroy();
      throw error;
    }

    return new BullMqCheckJobConsumer(worker, async () => {
      if (redis.isOpen) await redis.close();
    });
  }

  async close(): Promise<void> {
    await this.worker.close();
    await this.closeRedis();
  }
}

function assertPositiveInteger(value: number, name: string): void {
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
