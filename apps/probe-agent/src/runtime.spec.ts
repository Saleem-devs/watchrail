import type { HttpExecutor } from '@watchrail/check-engine';
import type { ProbeExecutionConfigurationV1, ProbeLeaseReferenceV1 } from '@watchrail/contracts';
import { describe, expect, it, vi } from 'vitest';
import { ProbeCoordinatorClient, ProbeCoordinatorError } from './coordinator-client.js';
import type { ProbeAgentConfig } from './config.js';
import { ProbeAgentRuntime } from './runtime.js';

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
  it('renews a slow check and submits its result', async () => {
    const { client, runtime, submit, renew } = runtimeFixture();
    vi.spyOn(client, 'renew').mockImplementation(renew);
    vi.spyOn(client, 'submitSerialized').mockImplementation(submit);
    await runtime.run();
    expect(renew).toHaveBeenCalled();
    expect(submit).toHaveBeenCalledOnce();
  });

  it('discards a result when renewal reports a stale claim', async () => {
    const { client, runtime, submit } = runtimeFixture();
    vi.spyOn(client, 'renew').mockRejectedValue(new ProbeCoordinatorError('STALE'));
    vi.spyOn(client, 'submitSerialized').mockImplementation(submit);
    await runtime.run();
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

  it('does not submit after the authoritative lease has expired', async () => {
    const expiredLease = { ...lease, leaseExpiresAt: '2000-01-01T00:00:00.000Z' };
    const { client, runtime, submit } = runtimeFixture(expiredLease);
    vi.spyOn(client, 'renew').mockRejectedValue(new ProbeCoordinatorError('TRANSIENT'));
    vi.spyOn(client, 'submitSerialized').mockImplementation(submit);
    await runtime.run();
    expect(submit).not.toHaveBeenCalled();
  });
});

function runtimeFixture(runtimeLease: ProbeLeaseReferenceV1 = lease) {
  const client = new ProbeCoordinatorClient('https://coordinator.example', 'm'.repeat(43));
  const state: { runtime?: ProbeAgentRuntime } = {};
  const claim = vi
    .fn()
    .mockResolvedValueOnce(runtimeLease)
    .mockImplementation(() => {
      state.runtime?.stop();
      return Promise.resolve(null);
    });
  vi.spyOn(client, 'claim').mockImplementation(claim);
  vi.spyOn(client, 'heartbeat').mockResolvedValue();
  vi.spyOn(client, 'configuration').mockResolvedValue(configuration);
  vi.spyOn(client, 'serializeSubmission').mockReturnValue('{"stable":true}');
  const renew = vi.fn().mockResolvedValue('2099-10-14T08:00:30.000Z');
  const submit = vi.fn().mockResolvedValue(undefined);
  const executor: HttpExecutor = {
    async execute() {
      await new Promise((resolve) => setTimeout(resolve, 25));
      return {
        type: 'RESPONSE',
        statusCode: 200,
        responseTimeMs: 5,
        headers: [],
        body: { state: 'NOT_REQUESTED' },
        redirects: [],
      };
    },
  };
  const runtime = new ProbeAgentRuntime(client, config, executor);
  state.runtime = runtime;
  return { client, runtime, renew, submit };
}
