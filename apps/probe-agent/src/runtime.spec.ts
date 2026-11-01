import type { HttpExecutor } from '@watchrail/check-engine';
import type { ProbeExecutionConfigurationV1, ProbeLeaseReferenceV1 } from '@watchrail/contracts';
import { HTTP_ENGINE_VERSION, LEGACY_HTTP_ENGINE_VERSION } from '@watchrail/domain';
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

    expect(claim).toHaveBeenNthCalledWith(1, HTTP_ENGINE_VERSION, expect.any(AbortSignal));
    expect(claim).toHaveBeenNthCalledWith(2, LEGACY_HTTP_ENGINE_VERSION, expect.any(AbortSignal));
    expect(submit).toHaveBeenCalledOnce();
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
) {
  const client = new ProbeCoordinatorClient('https://coordinator.example', 'm'.repeat(43));
  const state: { runtime?: ProbeAgentRuntime } = {};
  const claim = vi.fn();
  if (legacyFallback) claim.mockResolvedValueOnce(null);
  claim.mockResolvedValueOnce(runtimeLease).mockImplementation(() => {
    state.runtime?.stop();
    return Promise.resolve(null);
  });
  vi.spyOn(client, 'claim').mockImplementation(claim);
  vi.spyOn(client, 'heartbeat').mockResolvedValue();
  vi.spyOn(client, 'configuration').mockResolvedValue(configuration);
  const serialize = vi.spyOn(client, 'serializeSubmission').mockReturnValue('{"stable":true}');
  const renew = vi.fn().mockResolvedValue('2099-10-14T08:00:30.000Z');
  const submit = vi.fn().mockResolvedValue(undefined);
  const executorAbort = vi.fn();
  const executor: HttpExecutor = {
    execute(input) {
      return new Promise((resolve, reject) => {
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
      });
    },
  };
  const runtime = new ProbeAgentRuntime(client, config, executor);
  state.runtime = runtime;
  return { client, runtime, claim, serialize, renew, submit, executorAbort };
}
import { getEventListeners } from 'node:events';
