import { Queue } from 'bullmq';
import { RedisContainer } from '@testcontainers/redis';
import type { StartedRedisContainer } from '@testcontainers/redis';
import { createClient } from 'redis';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CHECK_EXECUTION_QUEUE, createExecuteCheckRoundJob } from '@watchrail/contracts';
import { BullMqCheckJobConsumer } from './check-job-consumer.js';
import { BullMqCheckJobPublisher } from './check-job-publisher.js';

const roundId = '11111111-1111-4111-8111-111111111111';

describe('BullMqCheckJobConsumer', () => {
  let container: StartedRedisContainer;
  let publisher: BullMqCheckJobPublisher;
  let inspectorClient: ReturnType<typeof createClient>;
  let inspectorQueue: Queue;

  beforeAll(async () => {
    container = await new RedisContainer('redis:8.2-alpine').start();
    publisher = await BullMqCheckJobPublisher.connect({
      redisUrl: container.getConnectionUrl(),
    });
    inspectorClient = createClient({ url: container.getConnectionUrl() });
    inspectorClient.on('error', () => undefined);
    await inspectorClient.connect();
    inspectorQueue = new Queue(CHECK_EXECUTION_QUEUE, { connection: inspectorClient });
  }, 60_000);

  beforeEach(async () => {
    await inspectorQueue.obliterate({ force: true });
  });

  afterAll(async () => {
    await inspectorQueue?.obliterate({ force: true });
    await inspectorQueue?.close();
    if (inspectorClient?.isOpen) await inspectorClient.close();
    await publisher?.close();
    await container?.stop();
  });

  it('validates and dispatches the canonical job payload', async () => {
    const payload = createExecuteCheckRoundJob(roundId);
    let observed: unknown;

    const consumer = await BullMqCheckJobConsumer.connect({
      redisUrl: container.getConnectionUrl(),
      handler: {
        handle: (job) => {
          observed = job;
          return Promise.resolve();
        },
      },
    });

    try {
      await publisher.publish(payload);
      await waitFor(() => observed !== undefined);
      expect(observed).toEqual(payload);
    } finally {
      await consumer.close();
    }
  });

  it('fails an invalid job without spending its retry budget', async () => {
    let handled = false;
    const consumer = await BullMqCheckJobConsumer.connect({
      redisUrl: container.getConnectionUrl(),
      handler: {
        handle: () => {
          handled = true;
          return Promise.resolve();
        },
      },
    });

    try {
      const job = await inspectorQueue.add(
        'not-the-contract-name',
        { unexpected: true },
        {
          attempts: 3,
        },
      );

      await waitFor(() => job.getState().then((state) => state === 'failed'));

      const failed = await inspectorQueue.getJob(job.id!);
      expect(failed?.attemptsMade).toBe(1);
      expect(handled).toBe(false);
    } finally {
      await consumer.close();
    }
  });
});

async function waitFor(predicate: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 5_000;

  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
  }

  throw new Error('Timed out waiting for the queue condition.');
}
