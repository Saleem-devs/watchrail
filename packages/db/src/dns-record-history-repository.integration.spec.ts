import { resolve } from 'node:path';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createMonitor, EMPTY_ASSERTION_EVALUATION } from '@watchrail/domain';
import { CheckExecutionRepository } from './check-execution-repository.js';
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
        monitors
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
});
