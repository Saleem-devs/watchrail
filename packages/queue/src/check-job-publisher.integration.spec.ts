import { Queue } from 'bullmq';
import { RedisContainer } from '@testcontainers/redis';
import { createClient } from 'redis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { StartedRedisContainer } from '@testcontainers/redis';
import {
  CHECK_EXECUTION_QUEUE,
  checkRoundJobId,
  createExecuteCheckRoundJob,
  EXECUTE_CHECK_ROUND_JOB,
} from '@watchrail/contracts';
import { BullMqCheckJobPublisher } from './check-job-publisher.js';

const firstRoundId = '11111111-1111-4111-8111-111111111111';
const secondRoundId = '22222222-2222-4222-8222-222222222222';

describe('BullMqCheckJobPublisher', () => {
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

  afterAll(async () => {
    await inspectorQueue?.obliterate({ force: true });
    await inspectorQueue?.close();
    if (inspectorClient?.isOpen) await inspectorClient.close();
    await publisher?.close();
    await container?.stop();
  });

  it('publishes the canonical job contract and retention policy', async () => {
    const payload = createExecuteCheckRoundJob(firstRoundId);

    await publisher.publish(payload);

    const job = await inspectorQueue.getJob(checkRoundJobId(firstRoundId));

    expect(job).not.toBeUndefined();
    expect(job?.name).toBe(EXECUTE_CHECK_ROUND_JOB);
    expect(job?.data).toEqual(payload);
    expect(job?.opts).toMatchObject({
      attempts: 10,
      backoff: { type: 'fixed', delay: 5_000 },
      removeOnComplete: { age: 3_600 },
      removeOnFail: { age: 86_400 },
    });
  });

  it('uses the deterministic ID as a duplicate-publication barrier', async () => {
    const payload = createExecuteCheckRoundJob(secondRoundId);

    await Promise.all([publisher.publish(payload), publisher.publish(payload)]);

    const jobs = await inspectorQueue.getJobs(['wait', 'prioritized', 'delayed']);
    const matching = jobs.filter((job) => job.id === checkRoundJobId(secondRoundId));

    expect(matching).toHaveLength(1);
  });

  it('fails connection quickly when Redis is unavailable', async () => {
    await expect(
      BullMqCheckJobPublisher.connect({
        redisUrl: 'redis://127.0.0.1:1',
        connectTimeoutMs: 250,
      }),
    ).rejects.toBeDefined();
  });
});
