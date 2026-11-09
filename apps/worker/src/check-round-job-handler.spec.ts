import { describe, expect, it, vi } from 'vitest';
import { Logger } from '@nestjs/common';
import type {
  HttpExecutor,
  IcmpPinger,
  RdapDomainClient,
  TcpConnector,
} from '@watchrail/check-engine';
import type { CheckExecutionRepository, WorkspaceSecretRepository } from '@watchrail/db';
import { encryptHeaderValue, type HeaderEncryptionKeyring } from '@watchrail/http-header-security';
import {
  storeResponseAssertions,
  type AssertionEncryptionKeyring,
} from '@watchrail/assertion-security';
import { EMPTY_ASSERTION_CONFIGURATION } from '@watchrail/domain';
import {
  CheckExecutionAlreadyClaimedError,
  CheckExecutionClaimLostError,
  CheckRoundJobHandler,
} from './check-round-job-handler.js';

const payload = {
  contractVersion: 1,
  roundId: '11111111-1111-4111-8111-111111111111',
} as const;

const claimedExecution = {
  type: 'HTTP',
  assignmentId: '22222222-2222-4222-8222-222222222222',
  claimToken: '33333333-3333-4333-8333-333333333333',
  attemptNumber: 1,
  url: 'https://example.com/health',
  method: 'GET',
  timeoutMs: 10_000,
  followRedirects: true,
  statusPolicy: { type: 'ANY_2XX' },
  organizationId: '44444444-4444-4444-8444-444444444444',
  monitorId: '55555555-5555-4555-8555-555555555555',
  requestHeaders: [],
  requestBody: { type: 'NONE' },
  assertions: EMPTY_ASSERTION_CONFIGURATION,
} as const;

const keyring: HeaderEncryptionKeyring = {
  activeKeyId: 'v1',
  keys: new Map([['v1', Buffer.alloc(32)]]),
};
const assertionKeyring: AssertionEncryptionKeyring = keyring;
const createExecutionValueResolver = vi.fn(() => () => Promise.resolve('workspace-secret'));
const workspaceSecrets = {
  createExecutionValueResolver,
} as unknown as WorkspaceSecretRepository;
const workspaceSecretKeyring = { activeKeyId: 'v1', keys: new Map([['v1', Buffer.alloc(32)]]) };

function createHandler(
  executions: CheckExecutionRepository,
  executor: HttpExecutor,
  encryptionKeyring: HeaderEncryptionKeyring = keyring,
  tcpConnector?: TcpConnector,
  rdapClient?: RdapDomainClient,
  icmpPinger?: IcmpPinger,
) {
  return new CheckRoundJobHandler(
    executions,
    executor,
    45_000,
    encryptionKeyring,
    assertionKeyring,
    workspaceSecrets,
    workspaceSecretKeyring,
    tcpConnector,
    undefined,
    rdapClient,
    icmpPinger,
  );
}

function createDependencies() {
  const claim = vi.fn<CheckExecutionRepository['claim']>();
  const complete = vi.fn<CheckExecutionRepository['complete']>();
  const execute = vi.fn<HttpExecutor['execute']>();
  const executions = {
    claim: (roundId: string, leaseDurationMs: number) => claim(roundId, leaseDurationMs),
    complete: (
      assignmentId: string,
      claimToken: string,
      result: Parameters<CheckExecutionRepository['complete']>[2],
    ) => complete(assignmentId, claimToken, result),
  } as unknown as CheckExecutionRepository;
  const executor: HttpExecutor = {
    execute: (input) => execute(input),
  };

  return { executions, executor, claim, complete, execute };
}

describe('CheckRoundJobHandler', () => {
  it('executes a claimed domain-expiry check and persists bounded evidence', async () => {
    const { executions, executor, claim, complete } = createDependencies();
    claim.mockResolvedValue({
      state: 'CLAIMED',
      execution: {
        type: 'DOMAIN_EXPIRY',
        assignmentId: claimedExecution.assignmentId,
        claimToken: claimedExecution.claimToken,
        attemptNumber: 1,
        timeoutMs: 10_000,
        organizationId: claimedExecution.organizationId,
        monitorId: claimedExecution.monitorId,
        domainName: 'example.com',
        warningDays: 30,
      },
    });
    complete.mockResolvedValue(true);
    const lookup = vi.fn<RdapDomainClient['lookup']>().mockResolvedValue({
      expirationDate: new Date(Date.now() + 10 * 86_400_000),
      sourceUrl: 'https://rdap.example/domain/example.com',
    });
    const rdapClient: RdapDomainClient = {
      lookup,
    };

    await createHandler(executions, executor, keyring, undefined, rdapClient).handle(payload);

    expect(lookup).toHaveBeenCalledWith('example.com', expect.any(AbortSignal));
    expect(complete).toHaveBeenCalledWith(
      claimedExecution.assignmentId,
      claimedExecution.claimToken,
      expect.objectContaining({
        outcome: 'FAIL',
        stage: 'DOMAIN',
        reason: 'DOMAIN_EXPIRING',
        domainExpiryResult: expect.objectContaining({
          contractVersion: 1,
          domainName: 'example.com',
          daysRemaining: 10,
          warningDays: 30,
        }),
      }),
    );
  });

  it('executes a claimed API workflow and persists its authoritative step trace', async () => {
    const { executions, executor, claim, complete, execute } = createDependencies();
    claim.mockResolvedValue({
      state: 'CLAIMED',
      execution: {
        type: 'API_WORKFLOW',
        assignmentId: claimedExecution.assignmentId,
        claimToken: claimedExecution.claimToken,
        attemptNumber: 1,
        timeoutMs: 10_000,
        organizationId: claimedExecution.organizationId,
        monitorId: claimedExecution.monitorId,
        workflow: {
          contractVersion: 1,
          steps: [
            {
              id: 'first',
              name: 'First request',
              url: 'https://example.com/first',
              method: 'GET',
              timeoutMs: 5_000,
              followRedirects: true,
              statusPolicy: { type: 'ANY_2XX' },
              tlsPolicy: { type: 'DISABLED' },
              requestHeaders: [],
              requestBody: { type: 'NONE' },
              assertions: EMPTY_ASSERTION_CONFIGURATION,
              extractions: [],
            },
            {
              id: 'second',
              name: 'Second request',
              url: 'https://example.com/second',
              method: 'GET',
              timeoutMs: 5_000,
              followRedirects: true,
              statusPolicy: { type: 'ANY_2XX' },
              tlsPolicy: { type: 'DISABLED' },
              requestHeaders: [],
              requestBody: { type: 'NONE' },
              assertions: EMPTY_ASSERTION_CONFIGURATION,
              extractions: [],
            },
          ],
        },
      },
    });
    execute.mockResolvedValue({
      type: 'RESPONSE',
      headers: [],
      body: { state: 'NOT_REQUESTED' },
      statusCode: 200,
      responseTimeMs: 12,
      redirects: [],
    });
    complete.mockResolvedValue(true);

    await createHandler(executions, executor).handle(payload);

    expect(execute).toHaveBeenCalledTimes(2);
    expect(complete).toHaveBeenCalledWith(
      claimedExecution.assignmentId,
      claimedExecution.claimToken,
      expect.objectContaining({
        outcome: 'PASS',
        stage: 'WORKFLOW',
        reason: 'WORKFLOW_COMPLETED',
        workflowResult: expect.objectContaining({
          outcome: 'PASS',
          steps: [
            expect.objectContaining({ id: 'first', status: 'EXECUTED' }),
            expect.objectContaining({ id: 'second', status: 'EXECUTED' }),
          ],
        }),
      }),
    );
  });

  it('executes a claimed HTTP check and persists its normalized result', async () => {
    const { executions, executor, claim, complete, execute } = createDependencies();
    claim.mockResolvedValue({
      state: 'CLAIMED',
      execution: claimedExecution,
    });
    execute.mockResolvedValue({
      type: 'RESPONSE',
      headers: [],
      body: { state: 'NOT_REQUESTED' },
      statusCode: 200,
      responseTimeMs: 12,
      redirects: [],
    });
    complete.mockResolvedValue(true);

    await createHandler(executions, executor).handle(payload);

    expect(claim).toHaveBeenCalledWith(payload.roundId, 45_000);
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({ followRedirects: true }));
    expect(complete).toHaveBeenCalledWith(
      claimedExecution.assignmentId,
      claimedExecution.claimToken,
      expect.objectContaining({
        outcome: 'PASS',
        stage: 'HTTP',
        reason: 'COMPLETED',
        statusCode: 200,
        responseTimeMs: 12,
      }),
    );
  });

  it('resolves vault-backed assertion values only for the authoritative execution', async () => {
    createExecutionValueResolver.mockClear();
    const { executions, executor, claim, complete, execute } = createDependencies();
    claim.mockResolvedValue({
      state: 'CLAIMED',
      execution: {
        ...claimedExecution,
        assertions: {
          contractVersion: 1,
          assertions: {
            headers: [],
            textBody: [
              {
                operator: 'contains',
                target: {
                  sensitive: true,
                  secretReference: {
                    contractVersion: 1,
                    secretId: '66666666-6666-4666-8666-666666666666',
                  },
                },
              },
            ],
            jsonBody: [],
          },
        },
      },
    });
    execute.mockResolvedValue({
      type: 'RESPONSE',
      headers: [],
      body: { state: 'CAPTURED', text: 'workspace-secret' },
      statusCode: 200,
      responseTimeMs: 12,
      redirects: [],
    });
    complete.mockResolvedValue(true);

    await createHandler(executions, executor).handle(payload);

    expect(execute).toHaveBeenCalledTimes(1);
    expect(complete).toHaveBeenCalledWith(
      claimedExecution.assignmentId,
      claimedExecution.claimToken,
      expect.objectContaining({
        outcome: 'PASS',
        assertionEvaluation: expect.objectContaining({ outcome: 'PASS' }),
      }),
    );
    expect(createExecutionValueResolver).toHaveBeenCalledTimes(1);
  });

  it('executes TCP claims through the protocol-specific connector', async () => {
    const { executions, executor, claim, complete, execute } = createDependencies();
    claim.mockResolvedValue({
      state: 'CLAIMED',
      execution: {
        type: 'TCP',
        assignmentId: claimedExecution.assignmentId,
        claimToken: claimedExecution.claimToken,
        attemptNumber: 1,
        organizationId: claimedExecution.organizationId,
        monitorId: claimedExecution.monitorId,
        host: '93.184.216.34',
        port: 5432,
        timeoutMs: 8_000,
      },
    });
    const connect = vi.fn().mockResolvedValue({ type: 'CONNECTED', connectionTimeMs: 18 });
    const connector: TcpConnector = { connect };
    complete.mockResolvedValue(true);

    await createHandler(executions, executor, keyring, connector).handle(payload);

    expect(execute).not.toHaveBeenCalled();
    expect(connect).toHaveBeenCalledWith(
      expect.objectContaining({ host: '93.184.216.34', port: 5432 }),
    );
    expect(complete).toHaveBeenCalledWith(
      claimedExecution.assignmentId,
      claimedExecution.claimToken,
      expect.objectContaining({
        outcome: 'PASS',
        stage: 'CONNECT',
        reason: 'CONNECTED',
        statusCode: null,
        responseTimeMs: 18,
      }),
    );
  });

  it('executes ICMP claims through the protocol-specific pinger', async () => {
    const { executions, executor, claim, complete, execute } = createDependencies();
    claim.mockResolvedValue({
      state: 'CLAIMED',
      execution: {
        type: 'ICMP',
        assignmentId: claimedExecution.assignmentId,
        claimToken: claimedExecution.claimToken,
        attemptNumber: 1,
        organizationId: claimedExecution.organizationId,
        monitorId: claimedExecution.monitorId,
        host: '93.184.216.34',
        timeoutMs: 5_000,
      },
    });
    const ping = vi.fn<IcmpPinger['ping']>().mockResolvedValue({
      type: 'REPLY',
      responseTimeMs: 14,
    });
    const pinger: IcmpPinger = { ping };
    complete.mockResolvedValue(true);

    await createHandler(executions, executor, keyring, undefined, undefined, pinger).handle(
      payload,
    );

    expect(execute).not.toHaveBeenCalled();
    expect(ping).toHaveBeenCalledWith(
      expect.objectContaining({
        host: '93.184.216.34',
        addresses: [expect.objectContaining({ address: '93.184.216.34' })],
      }),
    );
    expect(complete).toHaveBeenCalledWith(
      claimedExecution.assignmentId,
      claimedExecution.claimToken,
      expect.objectContaining({
        outcome: 'PASS',
        stage: 'ICMP',
        reason: 'PING_REPLIED',
        statusCode: null,
        responseTimeMs: 14,
      }),
    );
  });

  it('decrypts the immutable assertion configuration and passes all categories to the engine', async () => {
    const { executions, executor, claim, complete, execute } = createDependencies();
    const assertions = storeResponseAssertions(
      {
        headers: [{ name: 'x-state', operator: 'exists' }],
        textBody: [{ operator: 'contains', target: { sensitive: true, value: 'ready secret' } }],
        jsonBody: [{ selector: '$.ready', operator: 'exists' }],
      },
      EMPTY_ASSERTION_CONFIGURATION,
      'GET',
      {
        organizationId: claimedExecution.organizationId,
        monitorId: claimedExecution.monitorId,
      },
      assertionKeyring,
      { allowRetain: false },
    );
    claim.mockResolvedValue({
      state: 'CLAIMED',
      execution: { ...claimedExecution, assertions },
    });
    execute.mockResolvedValue({
      type: 'RESPONSE',
      headers: [],
      body: { state: 'CAPTURED', text: '{"ready":true}' },
      statusCode: 200,
      responseTimeMs: 12,
      redirects: [],
    });
    complete.mockResolvedValue(true);

    await createHandler(executions, executor).handle(payload);

    expect(execute).toHaveBeenCalledWith(expect.objectContaining({ captureResponseBody: true }));
    expect(complete).toHaveBeenCalledWith(
      claimedExecution.assignmentId,
      claimedExecution.claimToken,
      expect.objectContaining({
        assertionEvaluation: {
          contractVersion: 1,
          outcome: 'FAIL',
          diagnostics: [
            expect.objectContaining({ source: 'HEADER', outcome: 'FAIL' }),
            expect.objectContaining({ source: 'TEXT_BODY', outcome: 'FAIL' }),
            expect.objectContaining({ source: 'JSON_BODY', outcome: 'PASS' }),
          ],
        },
      }),
    );
  });

  it('evaluates the immutable exact status policy before persisting', async () => {
    const { executions, executor, claim, complete, execute } = createDependencies();
    claim.mockResolvedValue({
      state: 'CLAIMED',
      execution: {
        ...claimedExecution,
        statusPolicy: { type: 'EXACT' as const, statusCodes: [404] },
      },
    });
    execute.mockResolvedValue({
      type: 'RESPONSE',
      headers: [],
      body: { state: 'NOT_REQUESTED' },
      statusCode: 404,
      responseTimeMs: 12,
      redirects: [],
    });
    complete.mockResolvedValue(true);

    await createHandler(executions, executor).handle(payload);

    expect(complete).toHaveBeenCalledWith(
      claimedExecution.assignmentId,
      claimedExecution.claimToken,
      expect.objectContaining({ outcome: 'PASS', statusCode: 404 }),
    );
  });

  it('decrypts immutable request headers only when invoking the executor', async () => {
    const { executions, executor, claim, complete, execute } = createDependencies();
    claim.mockResolvedValue({
      state: 'CLAIMED',
      execution: {
        ...claimedExecution,
        requestHeaders: [
          {
            name: 'authorization',
            sensitive: true as const,
            encryptedValue: encryptHeaderValue(
              'Bearer secret',
              {
                organizationId: claimedExecution.organizationId,
                monitorId: claimedExecution.monitorId,
                normalizedHeaderName: 'authorization',
              },
              keyring,
            ),
          },
        ],
      },
    });
    execute.mockResolvedValue({
      type: 'RESPONSE',
      headers: [],
      body: { state: 'NOT_REQUESTED' },
      statusCode: 200,
      responseTimeMs: 12,
      redirects: [],
    });
    complete.mockResolvedValue(true);

    await createHandler(executions, executor).handle(payload);

    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({
        requestHeaders: [{ name: 'authorization', value: 'Bearer secret' }],
      }),
    );
  });

  it('turns corrupted stored headers into redacted internal evidence', async () => {
    const sentinel = 'WATCHRAIL_SENTINEL_SECRET';
    const logger = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const { executions, executor, claim, complete, execute } = createDependencies();
    claim.mockResolvedValue({
      state: 'CLAIMED',
      execution: {
        ...claimedExecution,
        requestHeaders: [
          {
            name: 'authorization',
            sensitive: true as const,
            encryptedValue: sentinel,
          },
        ] as never,
      },
    });
    complete.mockResolvedValue(true);

    await createHandler(executions, executor).handle(payload);

    expect(execute).not.toHaveBeenCalled();
    expect(complete).toHaveBeenCalledWith(
      claimedExecution.assignmentId,
      claimedExecution.claimToken,
      expect.objectContaining({ outcome: 'UNKNOWN', stage: 'PROBE', reason: 'INTERNAL_ERROR' }),
    );
    expect(logger).toHaveBeenCalledWith(
      `Stored request-header configuration is invalid for assignment ${claimedExecution.assignmentId}.`,
    );
    expect(JSON.stringify({ logs: logger.mock.calls, result: complete.mock.calls })).not.toContain(
      sentinel,
    );
    logger.mockRestore();
  });

  it('turns corrupted stored assertions into redacted terminal internal evidence', async () => {
    const sentinel = 'WATCHRAIL_ASSERTION_SENTINEL_SECRET';
    const logger = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const { executions, executor, claim, complete, execute } = createDependencies();
    claim.mockResolvedValue({
      state: 'CLAIMED',
      execution: {
        ...claimedExecution,
        assertions: {
          contractVersion: 1,
          assertions: {
            headers: [],
            textBody: [
              {
                operator: 'equals',
                target: { sensitive: true, encryptedValue: sentinel },
              },
            ],
            jsonBody: [],
          },
        } as never,
      },
    });
    complete.mockResolvedValue(true);

    await createHandler(executions, executor).handle(payload);

    expect(execute).not.toHaveBeenCalled();
    expect(complete).toHaveBeenCalledWith(
      claimedExecution.assignmentId,
      claimedExecution.claimToken,
      expect.objectContaining({ outcome: 'UNKNOWN', stage: 'PROBE', reason: 'INTERNAL_ERROR' }),
    );
    expect(logger).toHaveBeenCalledWith(
      `Stored assertion configuration is invalid for assignment ${claimedExecution.assignmentId}.`,
    );
    expect(JSON.stringify({ logs: logger.mock.calls, result: complete.mock.calls })).not.toContain(
      sentinel,
    );
    logger.mockRestore();
  });

  it('turns authenticated-decryption failure into terminal internal evidence', async () => {
    const { executions, executor, claim, complete, execute } = createDependencies();
    const encryptedValue = encryptHeaderValue(
      'Bearer secret',
      {
        organizationId: claimedExecution.organizationId,
        monitorId: claimedExecution.monitorId,
        normalizedHeaderName: 'authorization',
      },
      keyring,
    );
    claim.mockResolvedValue({
      state: 'CLAIMED',
      execution: {
        ...claimedExecution,
        requestHeaders: [
          {
            name: 'authorization',
            sensitive: true as const,
            encryptedValue: { ...encryptedValue, authTag: Buffer.alloc(16).toString('base64url') },
          },
        ],
      },
    });
    complete.mockResolvedValue(true);

    await createHandler(executions, executor).handle(payload);

    expect(execute).not.toHaveBeenCalled();
    expect(complete).toHaveBeenCalledWith(
      claimedExecution.assignmentId,
      claimedExecution.claimToken,
      expect.objectContaining({ outcome: 'UNKNOWN', stage: 'PROBE', reason: 'INTERNAL_ERROR' }),
    );
  });

  it('lets unexpected header-resolution failures reach infrastructure retry handling', async () => {
    const { executions, executor, claim, complete, execute } = createDependencies();
    const encryptedValue = encryptHeaderValue(
      'Bearer secret',
      {
        organizationId: claimedExecution.organizationId,
        monitorId: claimedExecution.monitorId,
        normalizedHeaderName: 'authorization',
      },
      keyring,
    );
    claim.mockResolvedValue({
      state: 'CLAIMED',
      execution: {
        ...claimedExecution,
        requestHeaders: [{ name: 'authorization', sensitive: true as const, encryptedValue }],
      },
    });
    const unexpected = new TypeError('unexpected keyring implementation failure');
    const brokenKeyring: HeaderEncryptionKeyring = {
      activeKeyId: 'v1',
      keys: {
        get: () => {
          throw unexpected;
        },
      } as unknown as ReadonlyMap<string, Buffer>,
    };

    await expect(createHandler(executions, executor, brokenKeyring).handle(payload)).rejects.toBe(
      unexpected,
    );
    expect(execute).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
  });

  it('treats a completed assignment as an idempotent replay', async () => {
    const { executions, executor, claim, complete, execute } = createDependencies();
    claim.mockResolvedValue({ state: 'COMPLETED' });

    await createHandler(executions, executor).handle(payload);

    expect(execute).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
  });

  it('retries while another worker owns the assignment', async () => {
    const { executions, executor, claim } = createDependencies();
    claim.mockResolvedValue({ state: 'BUSY' });

    await expect(createHandler(executions, executor).handle(payload)).rejects.toBeInstanceOf(
      CheckExecutionAlreadyClaimedError,
    );
  });

  it('retries when its database claim is replaced before completion', async () => {
    const { executions, executor, claim, complete, execute } = createDependencies();
    claim.mockResolvedValue({
      state: 'CLAIMED',
      execution: claimedExecution,
    });
    execute.mockResolvedValue({
      type: 'RESPONSE',
      headers: [],
      body: { state: 'NOT_REQUESTED' },
      statusCode: 503,
      responseTimeMs: 10,
      redirects: [],
    });
    complete.mockResolvedValue(false);

    await expect(createHandler(executions, executor).handle(payload)).rejects.toBeInstanceOf(
      CheckExecutionClaimLostError,
    );
  });

  it('persists unsupported stored methods as an internal execution failure', async () => {
    const { executions, executor, claim, complete, execute } = createDependencies();
    claim.mockResolvedValue({
      state: 'CLAIMED',
      execution: { ...claimedExecution, method: 'TRACE' as never },
    });
    complete.mockResolvedValue(true);

    await createHandler(executions, executor).handle(payload);

    expect(execute).not.toHaveBeenCalled();
    expect(complete).toHaveBeenCalledWith(
      claimedExecution.assignmentId,
      claimedExecution.claimToken,
      expect.objectContaining({
        outcome: 'UNKNOWN',
        stage: 'PROBE',
        reason: 'INTERNAL_ERROR',
      }),
    );
  });
});
