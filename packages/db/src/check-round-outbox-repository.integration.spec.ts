import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { createMonitor } from '@watchrail/domain';
import { CheckRoundOutboxRepository } from './check-round-outbox-repository.js';
import { createDatabaseConnection, type DatabaseConnection } from './client.js';
import { ManualRoundRepository } from './manual-round-repository.js';
import { migrateDatabase } from './migration.js';
import { MonitorRepository } from './monitor-repository.js';
import { checkRoundOutbox } from './schema.js';

const organizationId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

describe('CheckRoundOutboxRepository', () => {
  let container: StartedPostgreSqlContainer;
  let connection: DatabaseConnection;
  let repository: CheckRoundOutboxRepository;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:18.0-alpine').start();
    connection = createDatabaseConnection(container.getConnectionUri());
    repository = new CheckRoundOutboxRepository(connection.db);

    await migrateDatabase(connection, resolve(process.cwd(), 'drizzle'));
  }, 60_000);

  beforeEach(async () => {
    await connection.pool.query(`
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
    await connection?.pool.end();
    await container?.stop();
  });

  async function createOutboxEvent(): Promise<string> {
    const monitor = await new MonitorRepository(connection.db).create(
      organizationId,
      createMonitor({
        name: 'Public API',
        url: 'https://example.com/health',
      }),
    );

    const round = await new ManualRoundRepository(connection.db).create(organizationId, monitor.id);

    const [event] = await connection.db
      .select({ id: checkRoundOutbox.id })
      .from(checkRoundOutbox)
      .where(eq(checkRoundOutbox.roundId, round.id));

    if (!event) throw new Error('Expected the manual round to create an outbox event.');

    return event.id;
  }

  async function expireClaim(eventId: string): Promise<void> {
    await connection.db
      .update(checkRoundOutbox)
      .set({ availableAt: sql`now() - interval '1 millisecond'` })
      .where(eq(checkRoundOutbox.id, eventId));
  }

  async function readEvent(eventId: string) {
    const [event] = await connection.db
      .select()
      .from(checkRoundOutbox)
      .where(eq(checkRoundOutbox.id, eventId));

    if (!event) throw new Error('Expected the outbox event to exist.');

    return event;
  }

  it('claims one eligible event with a database-timed lease and fencing token', async () => {
    const eventId = await createOutboxEvent();

    const claimed = await repository.claimNext();

    expect(claimed).toMatchObject({
      id: eventId,
      attemptCount: 1,
      lastErrorCode: null,
      blockedAt: null,
      blockedReason: null,
      publishedAt: null,
    });
    expect(claimed?.claimToken).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(claimed?.lastAttemptAt).toBeInstanceOf(Date);
    expect(claimed!.availableAt.getTime()).toBeGreaterThan(claimed!.lastAttemptAt.getTime());

    expect(await repository.claimNext()).toBeNull();
  });

  it('lets concurrent relays claim different events without waiting on each other', async () => {
    const firstEventId = await createOutboxEvent();
    const secondEventId = await createOutboxEvent();

    const [firstClaim, secondClaim] = await Promise.all([
      repository.claimNext(),
      new CheckRoundOutboxRepository(connection.db).claimNext(),
    ]);

    expect(new Set([firstClaim?.id, secondClaim?.id])).toEqual(
      new Set([firstEventId, secondEventId]),
    );
    expect(firstClaim?.claimToken).not.toBe(secondClaim?.claimToken);
  });

  it('reclaims an expired lease with a new token and preserves attempt history', async () => {
    const eventId = await createOutboxEvent();
    const firstClaim = await repository.claimNext();

    await expireClaim(eventId);

    const secondClaim = await repository.claimNext();

    expect(secondClaim).toMatchObject({ id: eventId, attemptCount: 2 });
    expect(secondClaim?.claimToken).not.toBe(firstClaim?.claimToken);
  });

  it('allows only the current claim owner to acknowledge publication', async () => {
    const eventId = await createOutboxEvent();
    const firstClaim = await repository.claimNext();

    await expireClaim(eventId);

    const secondClaim = await repository.claimNext();

    expect(await repository.acknowledgePublished(eventId, firstClaim!.claimToken)).toBe(false);
    expect(await repository.acknowledgePublished(eventId, secondClaim!.claimToken)).toBe(true);

    const event = await readEvent(eventId);

    expect(event.publishedAt).toBeInstanceOf(Date);
    expect(event.claimToken).toBeNull();
    expect(event.lastErrorCode).toBeNull();
  });

  it('delays transient failure and preserves its error across the next claim', async () => {
    const eventId = await createOutboxEvent();
    const firstClaim = await repository.claimNext();

    expect(
      await repository.releaseForRetry(
        eventId,
        firstClaim!.claimToken,
        60_000,
        'REDIS_UNAVAILABLE',
      ),
    ).toBe(true);

    const delayed = await readEvent(eventId);

    expect(delayed).toMatchObject({
      claimToken: null,
      attemptCount: 1,
      lastErrorCode: 'REDIS_UNAVAILABLE',
      publishedAt: null,
    });
    expect(await repository.claimNext()).toBeNull();

    await expireClaim(eventId);

    const secondClaim = await repository.claimNext();

    expect(secondClaim).toMatchObject({
      attemptCount: 2,
      lastErrorCode: 'REDIS_UNAVAILABLE',
    });
  });

  it('blocks an invalid event without starving later eligible work', async () => {
    const invalidEventId = await createOutboxEvent();
    const invalidClaim = await repository.claimNext();

    expect(await repository.blockInvalid(invalidEventId, invalidClaim!.claimToken)).toBe(true);

    const blocked = await readEvent(invalidEventId);

    expect(blocked).toMatchObject({
      claimToken: null,
      blockedReason: 'INVALID_CONTRACT',
      publishedAt: null,
    });
    expect(blocked.blockedAt).toBeInstanceOf(Date);

    const nextEventId = await createOutboxEvent();
    const nextClaim = await repository.claimNext();

    expect(nextClaim?.id).toBe(nextEventId);
  });

  it('does not let a stale token release or block a newer claim', async () => {
    const eventId = await createOutboxEvent();
    const claim = await repository.claimNext();
    const staleToken = randomUUID();

    expect(
      await repository.releaseForRetry(eventId, staleToken, 1_000, 'QUEUE_PUBLICATION_TIMEOUT'),
    ).toBe(false);
    expect(await repository.blockInvalid(eventId, staleToken)).toBe(false);

    const event = await readEvent(eventId);

    expect(event.claimToken).toBe(claim?.claimToken);
    expect(event.blockedAt).toBeNull();
    expect(event.lastErrorCode).toBeNull();
  });

  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid millisecond duration %s',
    async (duration) => {
      await expect(repository.claimNext(duration)).rejects.toBeInstanceOf(RangeError);
    },
  );
});
