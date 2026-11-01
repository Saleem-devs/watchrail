import type { DnsQueryResolver, HttpExecutor, TcpConnector } from '@watchrail/check-engine';
import type { ProbeExecutionConfigurationV1, ProbeLeaseReferenceV1 } from '@watchrail/contracts';
import {
  HTTP_ENGINE_VERSION,
  LEGACY_HTTP_ENGINE_VERSION,
  TCP_ENGINE_VERSION,
  DNS_ENGINE_VERSION,
} from '@watchrail/domain';
import { describe, expect, it, vi } from 'vitest';
import { ProbeCoordinatorClient, ProbeCoordinatorError } from './coordinator-client.js';
import type { ProbeAgentConfig } from './config.js';
import { ProbeAgentRuntime, waitForDelay } from './runtime.js';

const lease: ProbeLeaseReferenceV1 = {
  contractVersion: 1,
  organizationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  locationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  assignmentId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  attemptId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  attemptNumber: 1,
  claimToken: 'c'.repeat(43),
  configurationVersionId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
  configurationVersionNumber: 1,
  executionPolicyVersion: 'probe-execution-v1',
  requiredEngineVersion: 'watchrail-http-v1',
  leaseExpiresAt: '2099-10-14T08:00:30.000Z',
};

const configuration: ProbeExecutionConfigurationV1 = {
  contractVersion: 1,
  assignmentId: lease.assignmentId,
  attemptId: lease.attemptId,
  configurationVersionId: lease.configurationVersionId,
  configurationVersionNumber: lease.configurationVersionNumber,
  executionPolicyVersion: lease.executionPolicyVersion,
  requiredEngineVersion: lease.requiredEngineVersion,
  url: 'https://example.com/health',
  method: 'GET',
  timeoutMs: 1_000,
  followRedirects: true,
  statusPolicy: { type: 'ANY_2XX' },
  requestHeaders: [],
  requestBody: { type: 'NONE' },
  assertions: { headers: [], textBody: [], jsonBody: [] },
};

const config: ProbeAgentConfig = {
  coordinatorUrl: 'https://coordinator.example',
  credential: 'm'.repeat(43),
  enrollment: null,
  credentialFile: null,
  pollIntervalMs: 1,
  heartbeatIntervalMs: 1_000,
  renewalIntervalMs: 5,
  requestTimeoutMs: 10_000,
};

describe('ProbeAgentRuntime', () => {
  it('removes abort listeners after normally completed waits', async () => {
    const controller = new AbortController();
    for (let index = 0; index < 20; index += 1) {
      await waitForDelay(1, controller.signal);
    }
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
  });

  it('renews a slow check and submits its result', async () => {
    const { client, runtime, serialize, submit, renew } = runtimeFixture();
    vi.spyOn(client, 'renew').mockImplementation(renew);
    vi.spyOn(client, 'submitSerialized').mockImplementation(submit);
    await runtime.run();
    expect(renew).toHaveBeenCalledWith(lease, LEGACY_HTTP_ENGINE_VERSION, expect.any(AbortSignal));
    expect(serialize).toHaveBeenCalledWith(
      lease,
      LEGACY_HTTP_ENGINE_VERSION,
      expect.not.objectContaining({ tlsCertificates: expect.anything() }),
    );
    expect(submit).toHaveBeenCalledOnce();
  });

  it('falls back to the legacy claim contract when a pre-upgrade coordinator has no v2 work', async () => {
    const { client, runtime, claim, submit } = runtimeFixture(lease, 1, true);
    vi.spyOn(client, 'submitSerialized').mockImplementation(submit);

    await runtime.run();

    expect(claim).toHaveBeenNthCalledWith(1, DNS_ENGINE_VERSION, expect.any(AbortSignal));
    expect(claim).toHaveBeenNthCalledWith(2, TCP_ENGINE_VERSION, expect.any(AbortSignal));
    expect(claim).toHaveBeenNthCalledWith(3, HTTP_ENGINE_VERSION, expect.any(AbortSignal));
    expect(claim).toHaveBeenNthCalledWith(4, LEGACY_HTTP_ENGINE_VERSION, expect.any(AbortSignal));
    expect(submit).toHaveBeenCalledOnce();
  });

  it('executes TCP assignments without routing them through the HTTP executor', async () => {
    const tcpConfiguration: ProbeExecutionConfigurationV1 = {
      contractVersion: 1,
      type: 'TCP',
      assignmentId: lease.assignmentId,
      attemptId: lease.attemptId,
      configurationVersionId: lease.configurationVersionId,
      configurationVersionNumber: lease.configurationVersionNumber,
      executionPolicyVersion: 'tcp-v1',
      requiredEngineVersion: TCP_ENGINE_VERSION,
      host: '93.184.216.34',
      port: 5432,
      timeoutMs: 8_000,
    };
    const tcpLease = {
      ...lease,
      executionPolicyVersion: 'tcp-v1',
      requiredEngineVersion: TCP_ENGINE_VERSION,
    };
    const connect = vi.fn().mockResolvedValue({ type: 'CONNECTED', connectionTimeMs: 23 });
    const connector: TcpConnector = { connect };
    const fixture = runtimeFixture(tcpLease, 1, false, tcpConfiguration, connector);
    vi.spyOn(fixture.client, 'submitSerialized').mockImplementation(fixture.submit);

    await fixture.runtime.run();

    expect(fixture.execute).not.toHaveBeenCalled();
    expect(connect).toHaveBeenCalledWith(
      expect.objectContaining({ host: '93.184.216.34', port: 5432 }),
    );
    expect(fixture.serialize).toHaveBeenCalledWith(
      tcpLease,
      TCP_ENGINE_VERSION,
      expect.objectContaining({ reason: 'CONNECTED', connectionTimeMs: 23 }),
    );
  });

  it('executes DNS assignments with the DNS engine', async () => {
    const dnsConfiguration: ProbeExecutionConfigurationV1 = {
      contractVersion: 1,
      type: 'DNS',
      assignmentId: lease.assignmentId,
      attemptId: lease.attemptId,
      configurationVersionId: lease.configurationVersionId,
      configurationVersionNumber: lease.configurationVersionNumber,
      executionPolicyVersion: 'dns-v1',
      requiredEngineVersion: DNS_ENGINE_VERSION,
      name: 'api.example.com',
      recordType: 'A',
      expectedValues: ['203.0.113.10'],
      timeoutMs: 8_000,
    };
    const dnsLease = {
      ...lease,
      executionPolicyVersion: 'dns-v1',
      requiredEngineVersion: DNS_ENGINE_VERSION,
    };
    const resolve = vi.fn().mockResolvedValue(['203.0.113.10']);
    const resolver: DnsQueryResolver = { resolve };
    const fixture = runtimeFixture(dnsLease, 1, false, dnsConfiguration, undefined, resolver);
    vi.spyOn(fixture.client, 'submitSerialized').mockImplementation(fixture.submit);

    await fixture.runtime.run();

    expect(fixture.execute).not.toHaveBeenCalled();
    expect(resolve).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'api.example.com', recordType: 'A' }),
    );
    expect(fixture.serialize).toHaveBeenCalledWith(
      dnsLease,
      DNS_ENGINE_VERSION,
      expect.objectContaining({ reason: 'RECORDS_MATCHED', answers: ['203.0.113.10'] }),
    );
  });

  it('discards a result when renewal reports a stale claim', async () => {
    const { client, runtime, submit, executorAbort } = runtimeFixture();
    vi.spyOn(client, 'renew').mockRejectedValue(new ProbeCoordinatorError('STALE'));
    vi.spyOn(client, 'submitSerialized').mockImplementation(submit);
    await runtime.run();
    expect(executorAbort).toHaveBeenCalledOnce();
    expect(submit).not.toHaveBeenCalled();
  });

  it('aborts an in-flight target request during shutdown', async () => {
    const { client, runtime, submit, executorAbort } = runtimeFixture(lease, 30_000);
    vi.spyOn(client, 'renew').mockResolvedValue('2099-10-14T08:00:30.000Z');
    vi.spyOn(client, 'submitSerialized').mockImplementation(submit);
    const running = runtime.run();
    await new Promise((resolve) => setTimeout(resolve, 10));
    runtime.stop();
    await running;
    expect(executorAbort).toHaveBeenCalledOnce();
    expect(submit).not.toHaveBeenCalled();
  });

  it('cancels hanging coordinator requests during shutdown', async () => {
    const fetcher = vi.fn(
      (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            'abort',
            () => reject(new DOMException('Aborted.', 'AbortError')),
            { once: true },
          );
        }),
    );
    const client = new ProbeCoordinatorClient(
      'https://coordinator.example',
      'm'.repeat(43),
      fetcher,
      30_000,
    );
    const runtime = new ProbeAgentRuntime(client, config, {
      execute: vi.fn(),
    });
    const running = runtime.run();
    await new Promise((resolve) => setTimeout(resolve, 10));
    runtime.stop();
    await expect(
      Promise.race([
        running.then(() => 'stopped'),
        new Promise<string>((resolve) => setTimeout(() => resolve('timeout'), 250)),
      ]),
    ).resolves.toBe('stopped');
  });

  it('cancels an outstanding claim when heartbeat authentication is revoked', async () => {
    const client = new ProbeCoordinatorClient('https://coordinator.example', 'm'.repeat(43));
    const claimAbort = vi.fn();
    vi.spyOn(client, 'claim').mockImplementation(
      (_engineVersion, signal) =>
        new Promise((_resolve, reject) => {
          const cancel = () => {
            claimAbort();
            reject(new DOMException('Aborted.', 'AbortError'));
          };
          if (signal?.aborted) cancel();
          else signal?.addEventListener('abort', cancel, { once: true });
        }),
    );
    vi.spyOn(client, 'heartbeat').mockRejectedValue(new ProbeCoordinatorError('AUTH'));
    const runtime = new ProbeAgentRuntime(client, config, { execute: vi.fn() });
    await runtime.run();
    expect(claimAbort).toHaveBeenCalledOnce();
  });

  it('does not submit after the authoritative lease has expired', async () => {
    const expiredLease = { ...lease, leaseExpiresAt: '2000-01-01T00:00:00.000Z' };
    const { client, runtime, submit } = runtimeFixture(expiredLease);
    vi.spyOn(client, 'renew').mockRejectedValue(new ProbeCoordinatorError('TRANSIENT'));
    vi.spyOn(client, 'submitSerialized').mockImplementation(submit);
    await runtime.run();
    expect(submit).not.toHaveBeenCalled();
  });
});

function runtimeFixture(
  runtimeLease: ProbeLeaseReferenceV1 = lease,
  executionDelayMs = 25,
  legacyFallback = false,
  runtimeConfiguration: ProbeExecutionConfigurationV1 = configuration,
  tcpConnector?: TcpConnector,
  dnsResolver?: DnsQueryResolver,
) {
  const client = new ProbeCoordinatorClient('https://coordinator.example', 'm'.repeat(43));
  const state: { runtime?: ProbeAgentRuntime } = {};
  const claim = vi.fn();
  if (legacyFallback) {
    claim.mockResolvedValueOnce(null).mockResolvedValueOnce(null).mockResolvedValueOnce(null);
  }
  claim.mockResolvedValueOnce(runtimeLease).mockImplementation(() => {
    state.runtime?.stop();
    return Promise.resolve(null);
  });
  vi.spyOn(client, 'claim').mockImplementation(claim);
  vi.spyOn(client, 'heartbeat').mockResolvedValue();
  vi.spyOn(client, 'configuration').mockResolvedValue(runtimeConfiguration);
  const serialize = vi.spyOn(client, 'serializeSubmission').mockReturnValue('{"stable":true}');
  const renew = vi.fn().mockResolvedValue('2099-10-14T08:00:30.000Z');
  const submit = vi.fn().mockResolvedValue(undefined);
  const executorAbort = vi.fn();
  const execute = vi.fn<HttpExecutor['execute']>(
    (input) =>
      new Promise((resolve, reject) => {
        const complete = () => {
          input.signal.removeEventListener('abort', cancel);
          resolve({
            type: 'RESPONSE',
            statusCode: 200,
            responseTimeMs: 5,
            headers: [],
            body: { state: 'NOT_REQUESTED' },
            redirects: [],
          });
        };
        const timer = setTimeout(complete, executionDelayMs);
        const cancel = () => {
          clearTimeout(timer);
          executorAbort();
          reject(new DOMException('Aborted.', 'AbortError'));
        };
        input.signal.addEventListener('abort', cancel, { once: true });
      }),
  );
  const executor: HttpExecutor = {
    execute: (input) => execute(input),
  };
  const runtime = new ProbeAgentRuntime(client, config, executor, tcpConnector, dnsResolver);
  state.runtime = runtime;
  return { client, runtime, claim, serialize, renew, submit, executorAbort, execute };
}
import { getEventListeners } from 'node:events';
