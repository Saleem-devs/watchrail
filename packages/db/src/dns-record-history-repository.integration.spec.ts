import { resolve } from 'node:path';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createMonitor, EMPTY_ASSERTION_EVALUATION } from '@watchrail/domain';
import { applyAvailabilityObservation, AvailabilityRepository } from './availability-repository.js';
import { CheckExecutionRepository, finalizeCheckExecution } from './check-execution-repository.js';
import { createDatabaseConnection, type DatabaseConnection } from './client.js';
import {
  applyDnsRecordObservation,
  clearDnsRecordCandidate,
  DnsRecordHistoryMonitorNotFoundError,
  DnsRecordHistoryRepository,
} from './dns-record-history-repository.js';
import { ManualRoundRepository } from './manual-round-repository.js';
import { migrateDatabase } from './migration.js';
import { MonitorRepository } from './monitor-repository.js';
import { ScheduledRoundRepository } from './scheduled-round-repository.js';
import { checkExecutionAssignments, probeLocations } from './schema.js';

const organizationId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

describe('DnsRecordHistoryRepository', () => {
  let container: StartedPostgreSqlContainer;
  let connection: DatabaseConnection;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:18.0-alpine').start();
    connection = createDatabaseConnection(container.getConnectionUri());
    await migrateDatabase(connection, resolve(process.cwd(), 'drizzle'));
  }, 60_000);

  beforeEach(async () => {
    await connection.pool.query(`
      truncate table
        dns_record_changes,
        dns_record_history_state,
        check_execution_assignments,
        check_round_locations,
        check_rounds,
        monitor_configuration_versions,
        monitors,
        probe_locations
      cascade
    `);
  });

  afterAll(async () => {
    await connection?.pool.end();
    await container?.stop();
  });

  it('establishes a baseline and records only a twice-observed change', async () => {
    const monitor = await new MonitorRepository(connection.db).create(
      organizationId,
      createMonitor({
        type: 'DNS',
        name: 'API DNS',
        dnsName: 'api.example.com',
        dnsRecordType: 'A',
      }),
    );
    const rounds = await Promise.all(
      [0, 1, 2, 3].map(() =>
        new ManualRoundRepository(connection.db).create(organizationId, monitor.id),
      ),
    );
    const base = new Date('2026-11-08T10:00:00.000Z');
    const observe = async (index: number, answers: string[]) =>
      connection.db.transaction((tx) =>
        applyDnsRecordObservation(tx, {
          organizationId,
          monitorId: monitor.id,
          configurationVersionId: rounds[index]!.monitorConfigurationVersionId,
          roundId: rounds[index]!.id,
          roundCreatedAt: new Date(base.getTime() + index * 60_000),
          observedAt: new Date(base.getTime() + index * 60_000 + 5_000),
          dnsName: 'api.example.com',
          recordType: 'A',
          answers,
          locations: [{ location: 'local', answers }],
        }),
      );

    await observe(0, ['203.0.113.10']);
    await observe(1, ['203.0.113.20']);
    let page = await new DnsRecordHistoryRepository(connection.db).listForMonitor(
      organizationId,
      monitor.id,
      { limit: 25 },
    );
    expect(page.current?.answers).toEqual(['203.0.113.10']);
    expect(page.candidate?.answers).toEqual(['203.0.113.20']);
    expect(page.items).toEqual([]);

    await observe(2, ['203.0.113.20']);
    page = await new DnsRecordHistoryRepository(connection.db).listForMonitor(
      organizationId,
      monitor.id,
      { limit: 25 },
    );
    expect(page.current?.answers).toEqual(['203.0.113.20']);
    expect(page.candidate).toBeNull();
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({
      beforeAnswers: ['203.0.113.10'],
      afterAnswers: ['203.0.113.20'],
    });

    await observe(2, ['203.0.113.20']);
    await observe(3, ['203.0.113.20']);
    page = await new DnsRecordHistoryRepository(connection.db).listForMonitor(
      organizationId,
      monitor.id,
      { limit: 25 },
    );
    expect(page.items).toHaveLength(1);

    await expect(
      new DnsRecordHistoryRepository(connection.db).listForMonitor(
        'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        monitor.id,
        { limit: 25 },
      ),
    ).rejects.toBeInstanceOf(DnsRecordHistoryMonitorNotFoundError);
  });

  it('breaks candidate confirmation after an indeterminate round', async () => {
    const monitor = await new MonitorRepository(connection.db).create(
      organizationId,
      createMonitor({
        type: 'DNS',
        name: 'Edge DNS',
        dnsName: 'edge.example.com',
        dnsRecordType: 'AAAA',
      }),
    );
    const rounds = await Promise.all(
      [0, 1, 2, 3].map(() =>
        new ManualRoundRepository(connection.db).create(organizationId, monitor.id),
      ),
    );
    const base = new Date('2026-11-08T11:00:00.000Z');
    const observe = async (index: number, answers: string[]) =>
      connection.db.transaction((tx) =>
        applyDnsRecordObservation(tx, {
          organizationId,
          monitorId: monitor.id,
          configurationVersionId: rounds[index]!.monitorConfigurationVersionId,
          roundId: rounds[index]!.id,
          roundCreatedAt: new Date(base.getTime() + index * 60_000),
          observedAt: new Date(base.getTime() + index * 60_000 + 2_000),
          dnsName: 'edge.example.com',
          recordType: 'AAAA',
          answers,
          locations: [{ location: 'local', answers }],
        }),
      );
    await observe(0, ['2001:db8::1']);
    await observe(1, ['2001:db8::2']);
    await connection.db.transaction((tx) =>
      clearDnsRecordCandidate(tx, {
        organizationId,
        monitorId: monitor.id,
        roundId: rounds[2]!.id,
        roundCreatedAt: new Date(base.getTime() + 2 * 60_000),
      }),
    );
    await observe(3, ['2001:db8::2']);

    const page = await new DnsRecordHistoryRepository(connection.db).listForMonitor(
      organizationId,
      monitor.id,
      { limit: 25 },
    );
    expect(page.items).toEqual([]);
    expect(page.candidate?.answers).toEqual(['2001:db8::2']);
  });

  it('preserves continuity across non-comparison configuration edits and fences older results', async () => {
    const monitors = new MonitorRepository(connection.db);
    const monitor = await monitors.create(
      organizationId,
      createMonitor({
        type: 'DNS',
        name: 'Stable DNS',
        dnsName: 'stable.example.com',
        dnsRecordType: 'A',
      }),
    );
    const manualRounds = new ManualRoundRepository(connection.db);
    const baselineRound = await manualRounds.create(organizationId, monitor.id);
    const olderInFlightRound = await manualRounds.create(organizationId, monitor.id);
    await monitors.updateScheduleSettings(
      organizationId,
      monitor.id,
      monitor.intervalSeconds === 120 ? 180 : 120,
    );
    const candidateRound = await manualRounds.create(organizationId, monitor.id);
    const confirmationRound = await manualRounds.create(organizationId, monitor.id);
    const base = new Date('2026-11-08T11:30:00.000Z');
    const observe = async (
      round: typeof baselineRound,
      minute: number,
      answers: string[],
      locations = [{ location: 'local', answers }],
    ) =>
      connection.db.transaction((tx) =>
        applyDnsRecordObservation(tx, {
          organizationId,
          monitorId: monitor.id,
          configurationVersionId: round.monitorConfigurationVersionId,
          roundId: round.id,
          roundCreatedAt: new Date(base.getTime() + minute * 60_000),
          observedAt: new Date(base.getTime() + minute * 60_000 + 2_000),
          dnsName: 'stable.example.com',
          recordType: 'A',
          answers,
          locations,
        }),
      );

    await observe(baselineRound, 0, ['203.0.113.10']);
    await observe(candidateRound, 2, ['203.0.113.20']);
    await observe(olderInFlightRound, 1, ['203.0.113.99']);
    await observe(confirmationRound, 3, ['203.0.113.20']);

    let page = await new DnsRecordHistoryRepository(connection.db).listForMonitor(
      organizationId,
      monitor.id,
      { limit: 25 },
    );
    expect(page.current?.answers).toEqual(['203.0.113.20']);
    expect(page.current?.configurationVersionId).toBe(
      confirmationRound.monitorConfigurationVersionId,
    );
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({
      beforeAnswers: ['203.0.113.10'],
      afterAnswers: ['203.0.113.20'],
    });

    const expandedScopeRound = await manualRounds.create(organizationId, monitor.id);
    await observe(
      expandedScopeRound,
      4,
      ['203.0.113.10', '203.0.113.20'],
      [
        { location: 'frankfurt', answers: ['203.0.113.20'] },
        { location: 'lagos', answers: ['203.0.113.10'] },
      ],
    );
    const reorderedEvidenceRound = await manualRounds.create(organizationId, monitor.id);
    await observe(
      reorderedEvidenceRound,
      5,
      ['203.0.113.20', '203.0.113.10'],
      [
        { location: 'lagos', answers: ['203.0.113.10'] },
        { location: 'frankfurt', answers: ['203.0.113.20'] },
      ],
    );
    page = await new DnsRecordHistoryRepository(connection.db).listForMonitor(
      organizationId,
      monitor.id,
      { limit: 25 },
    );
    expect(page.current?.locationEvidence).toEqual([
      { location: 'frankfurt', answers: ['203.0.113.20'] },
      { location: 'lagos', answers: ['203.0.113.10'] },
    ]);
    expect(page.candidate).toBeNull();
    expect(page.items).toHaveLength(1);
  });

  it('integrates with scheduled finalization while ignoring manual check results', async () => {
    const monitor = await new MonitorRepository(connection.db).create(
      organizationId,
      createMonitor({
        type: 'DNS',
        name: 'Authoritative DNS',
        dnsName: 'www.example.com',
        dnsRecordType: 'A',
      }),
    );
    const executions = new CheckExecutionRepository(connection.db);
    const complete = async (roundId: string, answer: string) => {
      const claim = await executions.claim(roundId, 45_000);
      if (claim.state !== 'CLAIMED') throw new Error('Expected a DNS execution claim.');
      await executions.complete(claim.execution.assignmentId, claim.execution.claimToken, {
        outcome: 'PASS',
        stage: 'DNS',
        reason: 'RECORDS_MATCHED',
        statusCode: null,
        responseTimeMs: 8,
        attemptDurationMs: 9,
        redirects: [],
        assertionEvaluation: EMPTY_ASSERTION_EVALUATION,
        dnsAnswers: [answer],
        checkedAt: new Date(),
      });
    };

    const manual = await new ManualRoundRepository(connection.db).create(
      organizationId,
      monitor.id,
    );
    await complete(manual.id, '203.0.113.5');
    let page = await new DnsRecordHistoryRepository(connection.db).listForMonitor(
      organizationId,
      monitor.id,
      { limit: 25 },
    );
    expect(page.current).toBeNull();

    const scheduled = new ScheduledRoundRepository(connection.db);
    for (const answer of ['203.0.113.10', '203.0.113.20', '203.0.113.20']) {
      await connection.pool.query(
        `update monitors set next_check_at = clock_timestamp() - interval '1 second' where id = $1`,
        [monitor.id],
      );
      const [round] = await scheduled.dispatchDue(1);
      if (!round) throw new Error('Expected a scheduled DNS round.');
      await complete(round.id, answer);
    }

    page = await new DnsRecordHistoryRepository(connection.db).listForMonitor(
      organizationId,
      monitor.id,
      { limit: 25 },
    );
    expect(page.current?.answers).toEqual(['203.0.113.20']);
    expect(page.items).toHaveLength(1);
  });

  it('records the immutable remote location and resets when the single-location scope changes', async () => {
    const monitors = new MonitorRepository(connection.db);
    const monitor = await monitors.create(
      organizationId,
      createMonitor({
        type: 'DNS',
        name: 'Regional DNS',
        dnsName: 'regional.example.com',
        dnsRecordType: 'A',
      }),
    );
    const [lagos, frankfurt] = await connection.db
      .insert(probeLocations)
      .values([
        { organizationId, name: 'Lagos', slug: 'lagos-dns-history' },
        { organizationId, name: 'Frankfurt', slug: 'frankfurt-dns-history' },
      ])
      .returning();
    const scheduled = new ScheduledRoundRepository(connection.db);
    const finalizeRemote = async (answer: string) => {
      await connection.pool.query(
        `update monitors set next_check_at = clock_timestamp() - interval '1 second' where id = $1`,
        [monitor.id],
      );
      const [round] = await scheduled.dispatchDue(1);
      if (!round) throw new Error('Expected a remote scheduled DNS round.');
      const [assignment] = await connection.db
        .select()
        .from(checkExecutionAssignments)
        .where(eq(checkExecutionAssignments.roundId, round.id));
      if (!assignment) throw new Error('Expected a remote DNS assignment.');
      await connection.db.transaction((tx) =>
        finalizeCheckExecution(tx, {
          assignmentId: assignment.id,
          organizationId,
          roundId: round.id,
          result: {
            outcome: 'PASS',
            stage: 'DNS',
            reason: 'RECORDS_MATCHED',
            statusCode: null,
            responseTimeMs: 8,
            attemptDurationMs: 9,
            redirects: [],
            assertionEvaluation: EMPTY_ASSERTION_EVALUATION,
            dnsAnswers: [answer],
            checkedAt: new Date(),
          },
        }),
      );
    };

    await monitors.updateLocations(organizationId, monitor.id, [lagos!.id]);
    await finalizeRemote('203.0.113.10');
    let page = await new DnsRecordHistoryRepository(connection.db).listForMonitor(
      organizationId,
      monitor.id,
      { limit: 25 },
    );
    expect(page.current?.locationEvidence).toEqual([
      { location: lagos!.id, answers: ['203.0.113.10'] },
    ]);

    await monitors.updateLocations(organizationId, monitor.id, [frankfurt!.id]);
    await finalizeRemote('203.0.113.20');
    await finalizeRemote('203.0.113.20');
    page = await new DnsRecordHistoryRepository(connection.db).listForMonitor(
      organizationId,
      monitor.id,
      { limit: 25 },
    );
    expect(page.current?.answers).toEqual(['203.0.113.20']);
    expect(page.current?.locationEvidence).toEqual([
      { location: frankfurt!.id, answers: ['203.0.113.20'] },
    ]);
    expect(page.candidate).toBeNull();
    expect(page.items).toEqual([]);
  });

  it('allows availability flushing to insert a daily bucket while DNS history owns its monitor lock', async () => {
    const monitor = await new MonitorRepository(connection.db).create(
      organizationId,
      createMonitor({
        type: 'DNS',
        name: 'Lock ordering DNS',
        dnsName: 'locks.example.com',
        dnsRecordType: 'A',
      }),
    );
    const round = await new ManualRoundRepository(connection.db).create(organizationId, monitor.id);
    const availabilityStartResult = await connection.pool.query<{ accountedThrough: Date }>(
      `update monitor_availability_state
       set tracking_started_at = clock_timestamp() - interval '1 hour',
           state_since = clock_timestamp() - interval '1 hour',
           accounted_through = clock_timestamp() - interval '1 hour',
           enabled_since = clock_timestamp() - interval '1 hour',
           updated_at = clock_timestamp() - interval '1 hour'
       where monitor_id = $1
       returning accounted_through as "accountedThrough"`,
      [monitor.id],
    );
    const availabilityStart = availabilityStartResult.rows[0]!.accountedThrough;

    let signalLocked!: () => void;
    const locked = new Promise<void>((resolve) => {
      signalLocked = resolve;
    });
    let releaseHistory!: () => void;
    const continueHistory = new Promise<void>((resolve) => {
      releaseHistory = resolve;
    });
    const historyTransaction = connection.db.transaction(async (tx) => {
      await applyDnsRecordObservation(tx, {
        organizationId,
        monitorId: monitor.id,
        configurationVersionId: round.monitorConfigurationVersionId,
        roundId: round.id,
        roundCreatedAt: new Date(),
        observedAt: new Date(),
        dnsName: 'locks.example.com',
        recordType: 'A',
        answers: ['203.0.113.10'],
        locations: [{ location: 'local', answers: ['203.0.113.10'] }],
      });
      signalLocked();
      await continueHistory;
      await applyAvailabilityObservation(
        tx,
        {
          id: round.id,
          createdAt: new Date(),
          organizationId,
          monitorId: monitor.id,
        },
        {
          trigger: 'SCHEDULED',
          outcome: 'PASS',
          reason: 'RECORDS_MATCHED',
          assertionOutcome: 'PASS',
        },
      );
    });
    await locked;

    const flush = new AvailabilityRepository(connection.db).flushDue(1, 1);
    try {
      await expect(
        Promise.race([
          flush,
          new Promise<never>((_, reject) =>
            setTimeout(
              () => reject(new Error('Availability flush blocked on DNS history lock.')),
              2_000,
            ),
          ),
        ]),
      ).resolves.toBe(1);

      const availabilityEndResult = await connection.pool.query<{ accountedThrough: Date }>(
        `select accounted_through as "accountedThrough"
         from monitor_availability_state
         where monitor_id = $1`,
        [monitor.id],
      );
      const availabilityEnd = availabilityEndResult.rows[0]!.accountedThrough;
      const daily = await connection.pool.query<{
        dayUtc: string;
        accountedMs: string;
      }>(
        `select to_char(day_utc, 'YYYY-MM-DD') as "dayUtc",
                (available_ms + unavailable_ms + unknown_ms + excluded_ms)::text as "accountedMs"
         from monitor_availability_daily
         where monitor_id = $1
         order by day_utc`,
        [monitor.id],
      );
      const expectedDays: string[] = [];
      const cursor = new Date(
        Date.UTC(
          availabilityStart.getUTCFullYear(),
          availabilityStart.getUTCMonth(),
          availabilityStart.getUTCDate(),
        ),
      );
      const lastAccruedInstant = new Date(availabilityEnd.getTime() - 1);
      const finalDay = new Date(
        Date.UTC(
          lastAccruedInstant.getUTCFullYear(),
          lastAccruedInstant.getUTCMonth(),
          lastAccruedInstant.getUTCDate(),
        ),
      );
      while (cursor <= finalDay) {
        expectedDays.push(cursor.toISOString().slice(0, 10));
        cursor.setUTCDate(cursor.getUTCDate() + 1);
      }
      expect(daily.rows.map((row) => row.dayUtc)).toEqual(expectedDays);
      expect(daily.rows.reduce((total, row) => total + Number(row.accountedMs), 0)).toBe(
        availabilityEnd.getTime() - availabilityStart.getTime(),
      );
    } finally {
      releaseHistory();
      await historyTransaction;
      await flush;
    }
  });
});
