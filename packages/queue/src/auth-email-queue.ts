import { Queue, Worker, createNodeRedisClient, UnrecoverableError } from 'bullmq';
import { createClient } from 'redis';
import {
  AUTH_EMAIL_QUEUE,
  DELIVER_AUTH_EMAIL_JOB,
  parseDeliverAuthEmailJob,
  type DeliverAuthEmailJobV1,
} from '@watchrail/contracts';

export class BullMqAuthEmailPublisher {
  private constructor(
    private readonly queue: Queue,
    private readonly closeRedis: () => Promise<void>,
  ) {}
  static async connect(redisUrl: string) {
    const redis = createClient({ url: redisUrl });
    await redis.connect();
    const queue = new Queue(AUTH_EMAIL_QUEUE, { connection: redis });
    await queue.waitUntilReady();
    return new BullMqAuthEmailPublisher(queue, async () => {
      if (redis.isOpen) await redis.close();
    });
  }
  async publish(messageId: string): Promise<void> {
    const payload: DeliverAuthEmailJobV1 = { contractVersion: 1, messageId };
    await this.queue.add(DELIVER_AUTH_EMAIL_JOB, payload, {
      jobId: `auth-email-${messageId}`,
      attempts: 8,
      backoff: { type: 'exponential', delay: 5_000 },
      removeOnComplete: { age: 3600 },
      removeOnFail: { age: 86_400 },
    });
  }
  async close() {
    await this.queue.close();
    await this.closeRedis();
  }
}

export class BullMqAuthEmailConsumer {
  private constructor(
    private readonly worker: Worker,
    private readonly closeRedis: () => Promise<void>,
  ) {}
  static async connect(
    redisUrl: string,
    handler: (job: DeliverAuthEmailJobV1) => Promise<void>,
    onTerminalFailure?: (messageId: string) => Promise<void>,
  ) {
    const redis = createClient({ url: redisUrl });
    await redis.connect();
    const worker = new Worker(
      AUTH_EMAIL_QUEUE,
      async (job) => {
        if (job.name !== DELIVER_AUTH_EMAIL_JOB)
          throw new UnrecoverableError('Invalid auth email job.');
        let parsed: DeliverAuthEmailJobV1;
        try {
          parsed = parseDeliverAuthEmailJob(job.data);
        } catch {
          throw new UnrecoverableError('Invalid auth email job.');
        }
        await handler(parsed);
      },
      { connection: createNodeRedisClient(redis), concurrency: 5 },
    );
    worker.on('failed', (job) => {
      if (!job || job.attemptsMade < (job.opts.attempts ?? 1)) return;
      try {
        const parsed = parseDeliverAuthEmailJob(job.data);
        void onTerminalFailure?.(parsed.messageId).catch(() => undefined);
      } catch {
        // Invalid jobs contain no trustworthy message identity.
      }
    });
    await worker.waitUntilReady();
    return new BullMqAuthEmailConsumer(worker, async () => {
      if (redis.isOpen) await redis.close();
    });
  }
  async close() {
    await this.worker.close();
    await this.closeRedis();
  }
}
