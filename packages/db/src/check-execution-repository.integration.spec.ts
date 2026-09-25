import { resolve } from 'node:path';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createMonitor } from '@watchrail/domain';
import { CheckExecutionRepository } from './check-execution-repository.js';
import { createDatabaseConnection } from './client.js';
import type { DatabaseConnection } from './client.js';
import { ManualRoundRepository } from './manual-round-repository.js';
import { migrateDatabase } from './migration.js';
import { MonitorRepository } from './monitor-repository.js';
import { checkExecutionAssignments, checkExecutionResults, checkRounds } from './schema.js';

const organizationId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

describe('CheckExecutionRepository', () => {
  let container: StartedPostgreSqlContainer;
  let connection: DatabaseConnection;
  let repository: CheckExecutionRepository;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:18.0-alpine').start();
    connection = createDatabaseConnection(container.getConnectionUri());
    await migrateDatabase(connection, resolve(process.cwd(), 'drizzle'));
    repository = new CheckExecutionRepository(connection.db);
  }, 60_000);

  beforeEach(async () => {
    await connection.pool.query(`
      truncate table
        check_execution_results,
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

  async function createRound(url = 'https://example.com/health') {
    const monitor = await new MonitorRepository(connection.db).create(
      organizationId,
      createMonitor({ name: 'Public API', url }),
    );

    return new ManualRoundRepository(connection.db).create(organizationId, monitor.id);
  }

  it('claims the local assignment with its immutable configuration', async () => {
    const round = await createRound();

    const claim = await repository.claim(round.id, 45_000);

    expect(claim).toMatchObject({
      state: 'CLAIMED',
      execution: {
        attemptNumber: 1,
        url: 'https://example.com/health',
        method: 'GET',
        timeoutMs: 10_000,
        statusPolicy: { type: 'ANY_2XX' },
      },
    });

    const [assignment] = await connection.db
      .select()
      .from(checkExecutionAssignments)
      .where(eq(checkExecutionAssignments.roundId, round.id));

    expect(assignment).toMatchObject({
      status: 'RUNNING',
      attemptCount: 1,
    });
    expect(assignment?.claimToken).toEqual(expect.any(String));
    expect(assignment?.claimExpiresAt).toBeInstanceOf(Date);
  });

  it('allows only one concurrent claimant', async () => {
    const round = await createRound();

    const claims = await Promise.all([
      repository.claim(round.id, 45_000),
      repository.claim(round.id, 45_000),
    ]);

    expect(claims.map((claim) => claim.state).sort()).toEqual(['BUSY', 'CLAIMED']);
  });

  it('persists one authoritative result and completes its round', async () => {
    const round = await createRound();
    const claim = await repository.claim(round.id, 45_000);

    if (claim.state !== 'CLAIMED') throw new Error('Expected an execution claim.');

    const checkedAt = new Date('2026-09-24T10:00:00.000Z');

    await expect(
      repository.complete(claim.execution.assignmentId, claim.execution.claimToken, {
        outcome: 'PASS',
        stage: 'HTTP',
        reason: 'COMPLETED',
        statusCode: 200,
        responseTimeMs: 12.5,
        attemptDurationMs: 14.25,
        checkedAt,
      }),
    ).resolves.toBe(true);

    const [assignment] = await connection.db
      .select()
      .from(checkExecutionAssignments)
      .where(eq(checkExecutionAssignments.id, claim.execution.assignmentId));
    const [result] = await connection.db.select().from(checkExecutionResults);
    const [completedRound] = await connection.db
      .select()
      .from(checkRounds)
      .where(eq(checkRounds.id, round.id));

    expect(assignment).toMatchObject({
      status: 'COMPLETED',
      claimToken: null,
      claimExpiresAt: null,
    });
    expect(assignment?.completedAt).toBeInstanceOf(Date);
    expect(result).toMatchObject({
      assignmentId: claim.execution.assignmentId,
      outcome: 'PASS',
      stage: 'HTTP',
      reason: 'COMPLETED',
      statusCode: 200,
      responseTimeMs: 12.5,
      attemptDurationMs: 14.25,
      checkedAt,
    });
    expect(completedRound?.status).toBe('COMPLETED');
    await expect(repository.claim(round.id, 45_000)).resolves.toEqual({ state: 'COMPLETED' });
  });

  it('rejects a stale claimant after an expired assignment is reclaimed', async () => {
    const round = await createRound();
    const first = await repository.claim(round.id, 45_000);

    if (first.state !== 'CLAIMED') throw new Error('Expected the first execution claim.');

    await connection.db
      .update(checkExecutionAssignments)
      .set({ claimExpiresAt: sql`now() - interval '1 millisecond'` })
      .where(eq(checkExecutionAssignments.id, first.execution.assignmentId));

    const second = await repository.claim(round.id, 45_000);

    if (second.state !== 'CLAIMED') throw new Error('Expected the reclaimed execution.');

    const result = {
      outcome: 'FAIL',
      stage: 'HTTP',
      reason: 'UNEXPECTED_STATUS',
      statusCode: 503,
      responseTimeMs: 20,
      attemptDurationMs: 21,
      checkedAt: new Date(),
    } as const;

    await expect(
      repository.complete(first.execution.assignmentId, first.execution.claimToken, result),
    ).resolves.toBe(false);
    await expect(
      repository.complete(second.execution.assignmentId, second.execution.claimToken, result),
    ).resolves.toBe(true);

    const results = await connection.db.select().from(checkExecutionResults);
    expect(results).toHaveLength(1);
  });
});
