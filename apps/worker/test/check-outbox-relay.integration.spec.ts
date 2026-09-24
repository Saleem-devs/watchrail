import { resolve } from 'node:path';
import { Queue } from 'bullmq';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer } from '@testcontainers/redis';
import { eq, sql } from 'drizzle-orm';
import { createClient } from 'redis';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { StartedRedisContainer } from '@testcontainers/redis';
import {
  CHECK_EXECUTION_QUEUE,
  checkRoundJobId,
  parseExecuteCheckRoundJob,
} from '@watchrail/contracts';
import {
  CheckRoundOutboxRepository,
  createDatabaseConnection,
  ManualRoundRepository,
  migrateDatabase,
  MonitorRepository,
  checkRoundOutbox,
  type DatabaseConnection,
} from '@watchrail/db';
import { createMonitor } from '@watchrail/domain';
import { BullMqCheckJobPublisher, type CheckJobPublisher } from '@watchrail/queue';
import { CheckOutboxRelay } from '../src/check-outbox-relay.js';

const organizationId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

describe('check-round outbox relay', () => {
  let postgres: StartedPostgreSqlContainer;
  let redis: StartedRedisContainer;
  let database: DatabaseConnection;
  let outbox: CheckRoundOutboxRepository;
  let publisher: BullMqCheckJobPublisher;
  let inspectorClient: ReturnType<typeof createClient>;
  let inspectorQueue: Queue;

  beforeAll(async () => {
    [postgres, redis] = await Promise.all([
      new PostgreSqlContainer('postgres:18.0-alpine').start(),
      new RedisContainer('redis:8.2-alpine').start(),
    ]);

    database = createDatabaseConnection(postgres.getConnectionUri());
    await migrateDatabase(database, resolve(process.cwd(), '../../packages/db/drizzle'));
    outbox = new CheckRoundOutboxRepository(database.db);
    publisher = await BullMqCheckJobPublisher.connect({
      redisUrl: redis.getConnectionUrl(),
    });

    inspectorClient = createClient({ url: redis.getConnectionUrl() });
    inspectorClient.on('error', () => undefined);
    await inspectorClient.connect();
    inspectorQueue = new Queue(CHECK_EXECUTION_QUEUE, { connection: inspectorClient });
  }, 60_000);

  beforeEach(async () => {
    await inspectorQueue.obliterate({ force: true });
    await database.pool.query(`
      truncate table
        check_round_outbox,
        check_execution_assignments,
        check_rounds,
        monitor_configuration_versions,
        monitors
      cascade
    `);
  });

  afterAll(async () => {
    await inspectorQueue?.obliterate({ force: true });
    await inspectorQueue?.close();
    if (inspectorClient?.isOpen) await inspectorClient.close();
    await publisher?.close();
    await database?.pool.end();
    await Promise.all([postgres?.stop(), redis?.stop()]);
  });

  async function createRound(): Promise<{ outboxId: string; roundId: string }> {
    const monitor = await new MonitorRepository(database.db).create(
      organizationId,
      createMonitor({
        name: 'Public API',
        url: 'https://example.com/health',
      }),
    );
    const round = await new ManualRoundRepository(database.db).create(organizationId, monitor.id);
    const [event] = await database.db
      .select({ id: checkRoundOutbox.id })
      .from(checkRoundOutbox)
      .where(eq(checkRoundOutbox.roundId, round.id));

    if (!event) throw new Error('Expected the round transaction to create an outbox event.');

    return { outboxId: event.id, roundId: round.id };
  }

  async function readOutboxEvent(outboxId: string) {
    const [event] = await database.db
      .select()
      .from(checkRoundOutbox)
      .where(eq(checkRoundOutbox.id, outboxId));

    if (!event) throw new Error('Expected the outbox event to exist.');

    return event;
  }

  it('publishes the durable event and acknowledges it in PostgreSQL', async () => {
    const created = await createRound();
    const relay = new CheckOutboxRelay(outbox, publisher, {
      leaseDurationMs: 30_000,
      retryDelayMs: () => 1_000,
    });

    await expect(relay.processNext()).resolves.toBe('PUBLISHED');

    const event = await readOutboxEvent(created.outboxId);
    const job = await inspectorQueue.getJob(checkRoundJobId(created.roundId));

    expect(event.publishedAt).toBeInstanceOf(Date);
    expect(event.claimToken).toBeNull();
    expect(event.attemptCount).toBe(1);
    expect(job?.data).toEqual({ contractVersion: 1, roundId: created.roundId });
  });

  it('releases a failed publication for durable retry', async () => {
    const created = await createRound();
    const unavailablePublisher: CheckJobPublisher = {
      publish: () => Promise.reject(new Error('Redis unavailable')),
    };
    const relay = new CheckOutboxRelay(outbox, unavailablePublisher, {
      leaseDurationMs: 30_000,
      retryDelayMs: () => 60_000,
    });

    await expect(relay.processNext()).resolves.toBe('RETRY_SCHEDULED');

    const event = await readOutboxEvent(created.outboxId);

    expect(event).toMatchObject({
      attemptCount: 1,
      claimToken: null,
      lastErrorCode: 'REDIS_UNAVAILABLE',
      publishedAt: null,
    });
    expect(event.availableAt.getTime()).toBeGreaterThan(Date.now());
    expect(await inspectorQueue.getJob(checkRoundJobId(created.roundId))).toBeUndefined();
  });

  it('deduplicates replay after publication succeeds but acknowledgement is lost', async () => {
    const created = await createRound();
    const firstClaim = await outbox.claimNext(30_000);

    if (!firstClaim) throw new Error('Expected the outbox event to be claimable.');

    await publisher.publish(parseExecuteCheckRoundJob(firstClaim.payload));

    await database.db
      .update(checkRoundOutbox)
      .set({ availableAt: sql`now() - interval '1 millisecond'` })
      .where(eq(checkRoundOutbox.id, created.outboxId));

    const relay = new CheckOutboxRelay(outbox, publisher, {
      leaseDurationMs: 30_000,
      retryDelayMs: () => 1_000,
    });

    await expect(relay.processNext()).resolves.toBe('PUBLISHED');

    const matchingJobs = (await inspectorQueue.getJobs(['wait', 'prioritized', 'delayed'])).filter(
      (job) => job.id === checkRoundJobId(created.roundId),
    );
    const event = await readOutboxEvent(created.outboxId);

    expect(matchingJobs).toHaveLength(1);
    expect(event.publishedAt).toBeInstanceOf(Date);
    expect(event.attemptCount).toBe(2);
  });
});
