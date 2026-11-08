import { resolve } from 'node:path';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createMonitor, EMPTY_ASSERTION_EVALUATION } from '@watchrail/domain';
import { CheckExecutionRepository } from './check-execution-repository.js';
import { CheckHistoryRepository } from './check-history-repository.js';
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

  async function createTcpRound() {
    const monitor = await new MonitorRepository(connection.db).create(
      organizationId,
      createMonitor({
        type: 'TCP',
        name: 'Primary database',
        host: 'db.example.com',
        port: 5432,
        timeoutMs: 8_000,
      }),
    );
    return new ManualRoundRepository(connection.db).create(organizationId, monitor.id);
  }

  async function createDnsRound() {
    const monitor = await new MonitorRepository(connection.db).create(
      organizationId,
      createMonitor({
        type: 'DNS',
        name: 'API DNS',
        dnsName: 'api.example.com',
        dnsRecordType: 'A',
        dnsExpectedValues: ['203.0.113.10'],
        timeoutMs: 8_000,
      }),
    );
    return new ManualRoundRepository(connection.db).create(organizationId, monitor.id);
  }

  async function createDomainExpiryRound() {
    const monitor = await new MonitorRepository(connection.db).create(
      organizationId,
      createMonitor({
        type: 'DOMAIN_EXPIRY',
        name: 'Primary domain',
        domainName: 'example.com',
        domainWarningDays: 30,
      }),
    );
    return new ManualRoundRepository(connection.db).create(organizationId, monitor.id);
  }

  async function createWorkflowRound(stepTimeouts: readonly number[] = [5_000, 5_000]) {
    const workflow = {
      contractVersion: 1 as const,
      steps: stepTimeouts.map((timeoutMs, index) => ({
        id: `step-${index}`,
        name: `Request ${index}`,
        url: `https://example.com/step-${index}`,
        method: 'GET' as const,
        timeoutMs,
        followRedirects: true,
        statusPolicy: { type: 'ANY_2XX' as const },
        tlsPolicy: { type: 'DISABLED' as const },
        requestHeaders: [],
        requestBody: { type: 'NONE' as const },
        assertions: {
          contractVersion: 1 as const,
          assertions: { headers: [], textBody: [], jsonBody: [] },
        },
        extractions: [],
      })),
    };
    const monitor = createMonitor({
      type: 'API_WORKFLOW',
      name: 'Checkout journey',
      workflow,
    });
    const created = await new MonitorRepository(connection.db).create(
      organizationId,
      'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      monitor,
      [],
      undefined,
      undefined,
      workflow,
    );
    return new ManualRoundRepository(connection.db).create(organizationId, created.id);
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
        followRedirects: true,
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

  it('persists and reloads a successful API workflow result', async () => {
    const round = await createWorkflowRound();
    const claim = await repository.claim(round.id, 45_000);
    if (claim.state !== 'CLAIMED' || claim.execution.type !== 'API_WORKFLOW') {
      throw new Error('Expected an API workflow execution claim.');
    }
    const [assignment] = await connection.db
      .select()
      .from(checkExecutionAssignments)
      .where(eq(checkExecutionAssignments.id, claim.execution.assignmentId));
    expect(assignment).toMatchObject({
      executionPolicyVersion: 'api-workflow-v1',
      requiredEngineVersion: 'watchrail-api-workflow-v1',
    });
    const checkedAt = new Date('2026-11-02T20:00:00.000Z');
    const workflowResult = {
      outcome: 'PASS' as const,
      stage: 'WORKFLOW' as const,
      reason: 'WORKFLOW_COMPLETED' as const,
      failedStepId: null,
      checkedAt,
      attemptDurationMs: 24,
      steps: claim.execution.workflow.steps.map((step, position) => ({
        id: step.id,
        name: step.name,
        position,
        status: 'EXECUTED' as const,
        result: {
          outcome: 'PASS' as const,
          stage: 'HTTP' as const,
          reason: 'COMPLETED' as const,
          statusCode: 200,
          responseTimeMs: 10,
          attemptDurationMs: 12,
          checkedAt,
          assertionEvaluation: EMPTY_ASSERTION_EVALUATION,
          redirectCount: 0,
          tlsCertificateCount: 0,
        },
        extractions: [],
      })),
    };

    await expect(
      repository.complete(claim.execution.assignmentId, claim.execution.claimToken, {
        outcome: 'PASS',
        stage: 'WORKFLOW',
        reason: 'WORKFLOW_COMPLETED',
        statusCode: null,
        responseTimeMs: null,
        attemptDurationMs: 24,
        redirects: [],
        assertionEvaluation: EMPTY_ASSERTION_EVALUATION,
        workflowResult,
        checkedAt,
      }),
    ).resolves.toBe(true);

    const stored = await new CheckHistoryRepository(connection.db).findForMonitor(
      organizationId,
      round.monitorId,
      round.id,
    );
    expect(stored?.result).toMatchObject({
      kind: 'SINGLE_LOCATION',
      outcome: 'PASS',
      stage: 'WORKFLOW',
      reason: 'WORKFLOW_COMPLETED',
      workflowResult: {
        outcome: 'PASS',
        steps: [
          { id: 'step-0', status: 'EXECUTED' },
          { id: 'step-1', status: 'EXECUTED' },
        ],
      },
    });
  });

  it('keeps the local lease authoritative through the maximum workflow deadline', async () => {
    const round = await createWorkflowRound([30_000, 30_000, 30_000]);
    const claim = await repository.claim(round.id, 45_000);
    if (claim.state !== 'CLAIMED') throw new Error('Expected an API workflow execution claim.');

    const [assignment] = await connection.db
      .select({
        claimExpiresAt: checkExecutionAssignments.claimExpiresAt,
        lastStartedAt: checkExecutionAssignments.lastStartedAt,
      })
      .from(checkExecutionAssignments)
      .where(eq(checkExecutionAssignments.id, claim.execution.assignmentId));

    expect(assignment?.claimExpiresAt?.getTime()).toBe(
      (assignment?.lastStartedAt?.getTime() ?? 0) + 95_000,
    );
  });

  it('rejects workflow stages without matching workflow evidence', async () => {
    const round = await createRound();
    const claim = await repository.claim(round.id, 45_000);
    if (claim.state !== 'CLAIMED') throw new Error('Expected an HTTP execution claim.');

    await expect(
      repository.complete(claim.execution.assignmentId, claim.execution.claimToken, {
        outcome: 'PASS',
        stage: 'HTTP',
        reason: 'COMPLETED',
        statusCode: 200,
        responseTimeMs: 10,
        attemptDurationMs: 12,
        redirects: [],
        assertionEvaluation: EMPTY_ASSERTION_EVALUATION,
        checkedAt: new Date('2026-11-02T20:00:00.000Z'),
      }),
    ).resolves.toBe(true);

    await expect(
      connection.db
        .update(checkExecutionResults)
        .set({ stage: 'WORKFLOW' })
        .where(eq(checkExecutionResults.roundId, round.id)),
    ).rejects.toMatchObject({
      cause: {
        constraint: 'check_execution_results_workflow_result_consistent',
      },
    });
  });

  it('claims TCP assignments with only their protocol-specific configuration', async () => {
    const round = await createTcpRound();
    const claim = await repository.claim(round.id, 45_000);

    expect(claim).toMatchObject({
      state: 'CLAIMED',
      execution: {
        type: 'TCP',
        attemptNumber: 1,
        host: 'db.example.com',
        port: 5432,
        timeoutMs: 8_000,
      },
    });
    if (claim.state !== 'CLAIMED') throw new Error('Expected a TCP execution claim.');
    if (claim.execution.type !== 'TCP') throw new Error('Expected TCP execution configuration.');
    expect(claim.execution.url).toBeUndefined();
    expect(claim.execution.statusPolicy).toBeUndefined();
  });

  it('persists and reloads a successful TCP connection result', async () => {
    const round = await createTcpRound();
    const claim = await repository.claim(round.id, 45_000);
    if (claim.state !== 'CLAIMED') throw new Error('Expected a TCP execution claim.');

    const checkedAt = new Date('2026-11-01T09:15:00.000Z');
    await expect(
      repository.complete(claim.execution.assignmentId, claim.execution.claimToken, {
        outcome: 'PASS',
        stage: 'CONNECT',
        reason: 'CONNECTED',
        statusCode: null,
        responseTimeMs: 18,
        attemptDurationMs: 24,
        redirects: [],
        assertionEvaluation: EMPTY_ASSERTION_EVALUATION,
        tlsCertificates: [],
        checkedAt,
      }),
    ).resolves.toBe(true);

    const stored = await new CheckHistoryRepository(connection.db).findForMonitor(
      organizationId,
      round.monitorId,
      round.id,
    );
    expect(stored?.result).toMatchObject({
      outcome: 'PASS',
      stage: 'CONNECT',
      reason: 'CONNECTED',
      statusCode: null,
      responseTimeMs: 18,
      attemptDurationMs: 24,
      checkedAt,
    });
  });

  it('persists and reloads a successful DNS result with bounded answer evidence', async () => {
    const round = await createDnsRound();
    const claim = await repository.claim(round.id, 45_000);
    if (claim.state !== 'CLAIMED' || claim.execution.type !== 'DNS') {
      throw new Error('Expected a DNS execution claim.');
    }
    expect(claim.execution).toMatchObject({
      name: 'api.example.com',
      recordType: 'A',
      expectedValues: ['203.0.113.10'],
    });

    const checkedAt = new Date('2026-11-01T09:20:00.000Z');
    await expect(
      repository.complete(claim.execution.assignmentId, claim.execution.claimToken, {
        outcome: 'PASS',
        stage: 'DNS',
        reason: 'RECORDS_MATCHED',
        statusCode: null,
        responseTimeMs: 12,
        attemptDurationMs: 14,
        redirects: [],
        assertionEvaluation: EMPTY_ASSERTION_EVALUATION,
        tlsCertificates: [],
        dnsAnswers: ['203.0.113.10'],
        checkedAt,
      }),
    ).resolves.toBe(true);

    const stored = await new CheckHistoryRepository(connection.db).findForMonitor(
      organizationId,
      round.monitorId,
      round.id,
    );
    expect(stored?.result).toMatchObject({
      outcome: 'PASS',
      stage: 'DNS',
      reason: 'RECORDS_MATCHED',
      responseTimeMs: 12,
      dnsAnswers: ['203.0.113.10'],
      checkedAt,
    });
  });

  it('claims immutable domain settings and reloads bounded expiry evidence', async () => {
    const round = await createDomainExpiryRound();
    const claim = await repository.claim(round.id, 45_000);
    if (claim.state !== 'CLAIMED' || claim.execution.type !== 'DOMAIN_EXPIRY') {
      throw new Error('Expected a domain expiry execution claim.');
    }
    expect(claim.execution).toMatchObject({
      domainName: 'example.com',
      warningDays: 30,
      timeoutMs: 10_000,
    });
    const checkedAt = new Date('2026-11-08T09:20:00.000Z');
    const evidence = {
      contractVersion: 1 as const,
      domainName: 'example.com',
      expirationDate: '2026-11-20T00:00:00.000Z',
      daysRemaining: 12,
      warningDays: 30,
    };
    await expect(
      repository.complete(claim.execution.assignmentId, claim.execution.claimToken, {
        outcome: 'FAIL',
        stage: 'DOMAIN',
        reason: 'DOMAIN_EXPIRING',
        statusCode: null,
        responseTimeMs: 85,
        attemptDurationMs: 90,
        redirects: [],
        assertionEvaluation: EMPTY_ASSERTION_EVALUATION,
        domainExpiryResult: evidence,
        checkedAt,
      }),
    ).resolves.toBe(true);
    const stored = await new CheckHistoryRepository(connection.db).findForMonitor(
      organizationId,
      round.monitorId,
      round.id,
    );
    expect(stored?.result).toMatchObject({
      outcome: 'FAIL',
      stage: 'DOMAIN',
      reason: 'DOMAIN_EXPIRING',
      responseTimeMs: 85,
      domainExpiryResult: evidence,
      checkedAt,
    });
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
    const redirects = [
      {
        sequence: 1,
        statusCode: 302 as const,
        source: { targetId: 1, origin: 'https://example.com:443' },
        destination: { targetId: 2, origin: 'https://status.example:443' },
        responseTimeMs: 7.5,
        headers: 'STRIPPED' as const,
      },
    ];
    const assertionEvaluation = {
      contractVersion: 1 as const,
      outcome: 'PASS' as const,
      diagnostics: [
        {
          index: 0,
          source: 'HEADER' as const,
          subject: 'x-state',
          operator: 'exists' as const,
          outcome: 'PASS' as const,
          reason: 'MATCHED' as const,
        },
        {
          index: 0,
          source: 'TEXT_BODY' as const,
          subject: null,
          operator: 'contains' as const,
          outcome: 'PASS' as const,
          reason: 'MATCHED' as const,
        },
        {
          index: 0,
          source: 'JSON_BODY' as const,
          subject: '$.ready',
          operator: 'exists' as const,
          outcome: 'PASS' as const,
          reason: 'MATCHED' as const,
        },
      ],
    };
    const tlsCertificates = [
      {
        contractVersion: 1 as const,
        origin: 'https://status.example',
        hostname: 'status.example',
        validFrom: '2026-09-01T00:00:00.000Z',
        validTo: '2027-09-01T00:00:00.000Z',
        fingerprint256:
          'CC:CC:CC:CC:CC:CC:CC:CC:CC:CC:CC:CC:CC:CC:CC:CC:CC:CC:CC:CC:CC:CC:CC:CC:CC:CC:CC:CC:CC:CC:CC:CC',
        subject: 'CN=status.example',
        issuer: 'CN=Example CA',
        protocol: 'TLSv1.3',
        cipher: 'TLS_AES_256_GCM_SHA384',
      },
    ];

    await expect(
      repository.complete(claim.execution.assignmentId, claim.execution.claimToken, {
        outcome: 'PASS',
        stage: 'HTTP',
        reason: 'COMPLETED',
        statusCode: 200,
        responseTimeMs: 12.5,
        attemptDurationMs: 14.25,
        redirects,
        assertionEvaluation,
        tlsCertificates,
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
      redirects,
      assertionEvaluation,
      tlsCertificates,
      checkedAt,
    });
    expect(completedRound?.status).toBe('COMPLETED');
    await expect(repository.claim(round.id, 45_000)).resolves.toEqual({ state: 'COMPLETED' });
  });

  it.each([
    ['contract version', { contractVersion: 2, outcome: 'PASS', diagnostics: [] }],
    [
      'too many diagnostics',
      {
        contractVersion: 1,
        outcome: 'PASS',
        diagnostics: Array.from({ length: 33 }, (_, index) => ({
          index,
          source: 'HEADER',
          subject: 'x-state',
          operator: 'exists',
          outcome: 'PASS',
          reason: 'MATCHED',
        })),
      },
    ],
    [
      'duplicate identity',
      {
        contractVersion: 1,
        outcome: 'PASS',
        diagnostics: [
          {
            index: 0,
            source: 'HEADER',
            subject: 'x-state',
            operator: 'exists',
            outcome: 'PASS',
            reason: 'MATCHED',
          },
          {
            index: 0,
            source: 'HEADER',
            subject: 'x-other',
            operator: 'exists',
            outcome: 'PASS',
            reason: 'MATCHED',
          },
        ],
      },
    ],
    [
      'aggregate mismatch',
      {
        contractVersion: 1,
        outcome: 'PASS',
        diagnostics: [
          {
            index: 0,
            source: 'HEADER',
            subject: 'x-state',
            operator: 'exists',
            outcome: 'FAIL',
            reason: 'HEADER_MISMATCH',
          },
        ],
      },
    ],
    [
      'reason/source mismatch',
      {
        contractVersion: 1,
        outcome: 'FAIL',
        diagnostics: [
          {
            index: 0,
            source: 'HEADER',
            subject: 'x-state',
            operator: 'exists',
            outcome: 'FAIL',
            reason: 'JSON_BODY_MISMATCH',
          },
        ],
      },
    ],
  ])('rejects an invalid assertion evaluation with %s before completion', async (_case, value) => {
    const round = await createRound();
    const claim = await repository.claim(round.id, 45_000);
    if (claim.state !== 'CLAIMED') throw new Error('Expected an execution claim.');

    await expect(
      repository.complete(claim.execution.assignmentId, claim.execution.claimToken, {
        outcome: 'PASS',
        stage: 'HTTP',
        reason: 'COMPLETED',
        statusCode: 200,
        responseTimeMs: 10,
        attemptDurationMs: 12,
        redirects: [],
        assertionEvaluation: value as never,
        checkedAt: new Date(),
      }),
    ).rejects.toMatchObject({ name: 'StoredAssertionContractError' });

    const [assignment] = await connection.db
      .select()
      .from(checkExecutionAssignments)
      .where(eq(checkExecutionAssignments.id, claim.execution.assignmentId));
    expect(assignment?.status).toBe('RUNNING');
    expect(await connection.db.select().from(checkExecutionResults)).toEqual([]);
  });

  it.each([
    [
      'FAIL',
      {
        contractVersion: 1 as const,
        outcome: 'FAIL' as const,
        diagnostics: [
          {
            index: 0,
            source: 'JSON_BODY' as const,
            subject: '$.status',
            operator: 'equals' as const,
            outcome: 'FAIL' as const,
            reason: 'JSON_BODY_MISMATCH' as const,
          },
        ],
      },
    ],
    [
      'NOT_EVALUATED',
      {
        contractVersion: 1 as const,
        outcome: 'NOT_EVALUATED' as const,
        diagnostics: [
          {
            index: 0,
            source: 'HEADER' as const,
            subject: 'content-type',
            operator: 'exists' as const,
            outcome: 'PASS' as const,
            reason: 'MATCHED' as const,
          },
          {
            index: 0,
            source: 'JSON_BODY' as const,
            subject: '$.status',
            operator: 'equals' as const,
            outcome: 'NOT_EVALUATED' as const,
            reason: 'RESPONSE_UNAVAILABLE' as const,
          },
        ],
      },
    ],
  ])('round-trips %s assertion evidence without changing HTTP PASS', async (_case, evaluation) => {
    const round = await createRound();
    const claim = await repository.claim(round.id, 45_000);
    if (claim.state !== 'CLAIMED') throw new Error('Expected an execution claim.');
    await repository.complete(claim.execution.assignmentId, claim.execution.claimToken, {
      outcome: 'PASS',
      stage: 'HTTP',
      reason: 'COMPLETED',
      statusCode: 200,
      responseTimeMs: 10,
      attemptDurationMs: 12,
      redirects: [],
      assertionEvaluation: evaluation,
      checkedAt: new Date(),
    });

    const stored = await new CheckHistoryRepository(connection.db).findForMonitor(
      organizationId,
      round.monitorId,
      round.id,
    );
    expect(stored?.result).toMatchObject({
      outcome: 'PASS',
      reason: 'COMPLETED',
      assertionEvaluation: evaluation,
    });
  });

  it('rejects corrupted redirect JSONB instead of exposing extra fields', async () => {
    const round = await createRound('https://example.com/invite/WATCHRAIL_PATH_SECRET');
    const claim = await repository.claim(round.id, 45_000);
    if (claim.state !== 'CLAIMED') throw new Error('Expected an execution claim.');

    await repository.complete(claim.execution.assignmentId, claim.execution.claimToken, {
      outcome: 'PASS',
      stage: 'HTTP',
      reason: 'COMPLETED',
      statusCode: 200,
      responseTimeMs: 10,
      attemptDurationMs: 12,
      redirects: [],
      assertionEvaluation: EMPTY_ASSERTION_EVALUATION,
      checkedAt: new Date(),
    });

    await connection.pool.query(
      `update check_execution_results
       set redirects = $1::jsonb
       where assignment_id = $2`,
      [
        JSON.stringify([
          {
            sequence: 1,
            statusCode: 302,
            source: { targetId: 1, origin: 'https://example.com:443' },
            destination: { targetId: 2, origin: 'https://status.example:443' },
            responseTimeMs: 5,
            headers: 'STRIPPED',
            rawLocation: '/WATCHRAIL_PATH_SECRET',
          },
        ]),
        claim.execution.assignmentId,
      ],
    );

    await expect(
      new CheckHistoryRepository(connection.db).findForMonitor(
        organizationId,
        round.monitorId,
        round.id,
      ),
    ).rejects.toMatchObject({ name: 'HttpRedirectDiagnosticsInvariantError' });
  });

  it('re-parses and rejects corrupted stored assertion evaluation JSONB', async () => {
    const round = await createRound();
    const claim = await repository.claim(round.id, 45_000);
    if (claim.state !== 'CLAIMED') throw new Error('Expected an execution claim.');

    await repository.complete(claim.execution.assignmentId, claim.execution.claimToken, {
      outcome: 'PASS',
      stage: 'HTTP',
      reason: 'COMPLETED',
      statusCode: 200,
      responseTimeMs: 10,
      attemptDurationMs: 12,
      redirects: [],
      assertionEvaluation: EMPTY_ASSERTION_EVALUATION,
      checkedAt: new Date(),
    });

    await connection.pool.query(
      `update check_execution_results
       set assertion_evaluation = $1::jsonb
       where assignment_id = $2`,
      [
        JSON.stringify({
          contractVersion: 1,
          outcome: 'PASS',
          diagnostics: [
            {
              index: 0,
              source: 'JSON_BODY',
              subject: '$.secret',
              operator: 'equals',
              outcome: 'FAIL',
              reason: 'JSON_BODY_MISMATCH',
              receivedValue: 'WATCHRAIL_RECEIVED_RESPONSE_SECRET',
            },
          ],
        }),
        claim.execution.assignmentId,
      ],
    );

    await expect(
      new CheckHistoryRepository(connection.db).findForMonitor(
        organizationId,
        round.monitorId,
        round.id,
      ),
    ).rejects.toMatchObject({ name: 'StoredAssertionContractError' });
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
      redirects: [],
      assertionEvaluation: EMPTY_ASSERTION_EVALUATION,
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
