import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createMonitor, EMPTY_ASSERTION_EVALUATION } from '@watchrail/domain';
import { CheckExecutionRepository } from './check-execution-repository.js';
import {
  CheckHistoryQueryError,
  CheckHistoryRepository,
  parseCheckHistoryQuery,
} from './check-history-repository.js';
import { createDatabaseConnection, type DatabaseConnection } from './client.js';
import { ManualRoundRepository } from './manual-round-repository.js';
import { migrateDatabase } from './migration.js';
import { MonitorRepository } from './monitor-repository.js';
import { ScheduledRoundRepository } from './scheduled-round-repository.js';
import { checkExecutionResults, checkRounds, monitors } from './schema.js';

const organizationId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const otherOrganizationId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

describe('CheckHistoryRepository', () => {
  let container: StartedPostgreSqlContainer;
  let connection: DatabaseConnection;
  let history: CheckHistoryRepository;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:18.0-alpine').start();
    connection = createDatabaseConnection(container.getConnectionUri());
    await migrateDatabase(connection, resolve(process.cwd(), 'drizzle'));
    history = new CheckHistoryRepository(connection.db);
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

  it('lists mixed history with stable cursor pagination and trigger filters', async () => {
    const monitor = await createMonitorRecord(organizationId);
    const manual = await new ManualRoundRepository(connection.db).create(
      organizationId,
      monitor.id,
    );
    await complete(manual.id, 'PASS', 200, 12);

    await connection.db
      .update(monitors)
      .set({ nextCheckAt: sql`clock_timestamp() - interval '1 second'` })
      .where(eq(monitors.id, monitor.id));
    const [scheduled] = await new ScheduledRoundRepository(connection.db).dispatchDue(1);
    await complete(scheduled!.id, 'FAIL', 503, 18);

    const pending = await new ManualRoundRepository(connection.db).create(
      organizationId,
      monitor.id,
    );
    const tiedAt = new Date('2026-01-01T00:00:00.000Z');
    await connection.db
      .update(checkRounds)
      .set({ createdAt: tiedAt })
      .where(eq(checkRounds.id, manual.id));
    await connection.db
      .update(checkRounds)
      .set({ createdAt: tiedAt })
      .where(eq(checkRounds.id, scheduled!.id));

    const first = await history.listForMonitor(organizationId, monitor.id, { limit: 2 });
    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();
    const second = await history.listForMonitor(organizationId, monitor.id, {
      limit: 2,
      cursor: first.nextCursor!,
    });
    expect([...first.items, ...second.items].map((round) => round.id)).toEqual([
      pending.id,
      ...[manual.id, scheduled!.id].sort().reverse(),
    ]);
    expect(new Set([...first.items, ...second.items].map((round) => round.id)).size).toBe(3);

    const scheduledOnly = await history.listForMonitor(organizationId, monitor.id, {
      limit: 25,
      trigger: 'SCHEDULED',
    });
    expect(scheduledOnly.items.map((round) => round.id)).toEqual([scheduled!.id]);
    expect(scheduledOnly.items[0]?.result).not.toHaveProperty('redirects');
    expect(scheduledOnly.items[0]?.result).not.toHaveProperty('assertionEvaluation');
  });

  it('derives current availability from the latest completed result and ignores newer pending work', async () => {
    const available = await createMonitorRecord(organizationId, 'Available');
    const unavailable = await createMonitorRecord(organizationId, 'Unavailable');
    const unknown = await createMonitorRecord(organizationId, 'Unknown');

    const availableRound = await createAndComplete(available.id, 'PASS', 200, 11);
    await createAndComplete(unavailable.id, 'FAIL', 503, 22);
    await createAndComplete(unknown.id, 'UNKNOWN', null, null);
    await new ManualRoundRepository(connection.db).create(organizationId, available.id);

    const current = await history.currentForOrganization(organizationId);
    expect(current.get(available.id)).toMatchObject({
      roundId: availableRound.id,
      availability: 'AVAILABLE',
      responseTimeMs: 11,
    });
    expect(current.get(unavailable.id)?.availability).toBe('UNAVAILABLE');
    expect(current.get(unknown.id)?.availability).toBe('UNKNOWN');
  });

  it('returns full scheduled details while enforcing organization isolation and archived access', async () => {
    const monitor = await createMonitorRecord(organizationId);
    const round = await createAndComplete(monitor.id, 'PASS', 200, 10);
    await new MonitorRepository(connection.db).updateLifecycle(
      organizationId,
      monitor.id,
      'ARCHIVED',
    );

    const detail = await history.findForMonitor(organizationId, monitor.id, round.id);
    expect(detail).toMatchObject({
      id: round.id,
      trigger: 'MANUAL',
      result: { assertionEvaluation: EMPTY_ASSERTION_EVALUATION, redirects: [] },
    });
    await expect(
      history.findForMonitor(otherOrganizationId, monitor.id, round.id),
    ).resolves.toBeNull();
  });

  it('rejects corrupted durable diagnostics on both list and detail reads', async () => {
    const monitor = await createMonitorRecord(organizationId);
    const round = await createAndComplete(monitor.id, 'PASS', 200, 10);
    await connection.db
      .update(checkExecutionResults)
      .set({ assertionEvaluation: { contractVersion: 1, outcome: 'FAIL', diagnostics: [] } })
      .where(eq(checkExecutionResults.roundId, round.id));

    await expect(
      history.listForMonitor(organizationId, monitor.id, { limit: 25 }),
    ).rejects.toMatchObject({ name: 'StoredAssertionContractError' });
    await expect(
      history.findForMonitor(organizationId, monitor.id, round.id),
    ).rejects.toMatchObject({ name: 'StoredAssertionContractError' });
  });

  async function createMonitorRecord(owner = organizationId, name = `Monitor ${randomUUID()}`) {
    return new MonitorRepository(connection.db).create(
      owner,
      createMonitor({ name, url: 'https://example.com/health' }),
    );
  }

  async function createAndComplete(
    monitorId: string,
    outcome: 'PASS' | 'FAIL' | 'UNKNOWN',
    statusCode: number | null,
    responseTimeMs: number | null,
  ) {
    const round = await new ManualRoundRepository(connection.db).create(organizationId, monitorId);
    await complete(round.id, outcome, statusCode, responseTimeMs);
    return round;
  }

  async function complete(
    roundId: string,
    outcome: 'PASS' | 'FAIL' | 'UNKNOWN',
    statusCode: number | null,
    responseTimeMs: number | null,
  ): Promise<void> {
    const executions = new CheckExecutionRepository(connection.db);
    const claim = await executions.claim(roundId, 45_000);
    if (claim.state !== 'CLAIMED') throw new Error('Expected claimed execution.');
    await executions.complete(claim.execution.assignmentId, claim.execution.claimToken, {
      outcome,
      stage: outcome === 'UNKNOWN' ? 'PROBE' : 'HTTP',
      reason:
        outcome === 'PASS'
          ? 'COMPLETED'
          : outcome === 'FAIL'
            ? 'UNEXPECTED_STATUS'
            : 'INTERNAL_ERROR',
      statusCode,
      responseTimeMs,
      attemptDurationMs: 25,
      redirects: [],
      assertionEvaluation: EMPTY_ASSERTION_EVALUATION,
      checkedAt: new Date(),
    });
  }
});

describe('parseCheckHistoryQuery', () => {
  it('applies defaults and accepts exact supported query strings', () => {
    expect(parseCheckHistoryQuery({})).toEqual({ limit: 25 });
    expect(parseCheckHistoryQuery({ limit: '100', trigger: 'SCHEDULED' })).toEqual({
      limit: 100,
      trigger: 'SCHEDULED',
    });
  });

  it.each([
    { limit: '0' },
    { limit: '101' },
    { limit: '1.5' },
    { limit: '01' },
    { trigger: 'OTHER' },
    { extra: 'value' },
    { cursor: 'not-a-cursor' },
  ])('rejects invalid query %#', (query) => {
    expect(() => parseCheckHistoryQuery(query)).toThrow(CheckHistoryQueryError);
  });
});
