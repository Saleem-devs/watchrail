import {
  executeHttpCheck,
  NodeHttpExecutor,
  type HttpCheckResult,
  type HttpExecutor,
} from '@watchrail/check-engine';
import {
  HTTP_ENGINE_VERSION,
  LEGACY_HTTP_ENGINE_VERSION,
  PROBE_MAX_EXECUTION_MS,
  parseResponseAssertions,
  probeEngineSupports,
} from '@watchrail/domain';
import type { ProbeLeaseReferenceV1 } from '@watchrail/contracts';
import { ProbeCoordinatorError } from './coordinator-client.js';
import type { ProbeCoordinatorClient } from './coordinator-client.js';
import type { ProbeAgentConfig } from './config.js';

export class ProbeAgentRuntime {
  private stopping = false;
  private activeAbort: AbortController | null = null;
  private readonly lifecycleAbort = new AbortController();

  constructor(
    private readonly client: ProbeCoordinatorClient,
    private readonly config: ProbeAgentConfig,
    private readonly executor: HttpExecutor = new NodeHttpExecutor(),
  ) {}

  async run(): Promise<void> {
    const heartbeat = this.heartbeatLoop();
    try {
      let failures = 0;
      while (!this.stopping) {
        try {
          const lease = await this.claimCompatibleLease();
          if (!lease) {
            failures = 0;
            await waitForDelay(this.config.pollIntervalMs, this.lifecycleAbort.signal);
            continue;
          }
          await this.executeLease(lease);
          failures = 0;
        } catch (error) {
          if (this.stopping) break;
          if (error instanceof ProbeCoordinatorError && error.kind === 'AUTH') {
            this.stopping = true;
            break;
          }
          failures += 1;
          await waitForDelay(
            Math.min(30_000, this.config.pollIntervalMs * 2 ** Math.min(failures, 3)),
            this.lifecycleAbort.signal,
          );
        }
      }
    } finally {
      this.stopping = true;
      this.lifecycleAbort.abort();
      this.activeAbort?.abort();
      await heartbeat;
    }
  }

  stop(): void {
    this.stopping = true;
    this.lifecycleAbort.abort();
    this.activeAbort?.abort();
  }

  private async executeLease(lease: ProbeLeaseReferenceV1): Promise<void> {
    const abort = new AbortController();
    const executionDeadline = setTimeout(() => abort.abort(), PROBE_MAX_EXECUTION_MS);
    const authority = { expiresAt: Date.parse(lease.leaseExpiresAt) };
    this.activeAbort = abort;
    const renewal = this.renewalLoop(lease, abort, authority);
    try {
      const configuration = await this.client.configuration(lease, abort.signal);
      if (
        configuration.assignmentId !== lease.assignmentId ||
        configuration.configurationVersionId !== lease.configurationVersionId ||
        configuration.configurationVersionNumber !== lease.configurationVersionNumber ||
        configuration.executionPolicyVersion !== lease.executionPolicyVersion ||
        configuration.requiredEngineVersion !== lease.requiredEngineVersion ||
        !probeEngineSupports(HTTP_ENGINE_VERSION, configuration.requiredEngineVersion)
      ) {
        throw new ProbeCoordinatorError('INVALID');
      }
      const assertions = parseResponseAssertions(configuration.assertions, configuration.method);
      const result = await executeHttpCheck(
        {
          url: configuration.url,
          method: configuration.method,
          timeoutMs: configuration.timeoutMs,
          followRedirects: configuration.followRedirects,
          statusPolicy: configuration.statusPolicy,
          tlsPolicy: configuration.tlsPolicy ?? { type: 'DISABLED' },
          requestHeaders: configuration.requestHeaders,
          requestBody: configuration.requestBody,
          headerAssertions: assertions.headers,
          textBodyAssertions: assertions.textBody,
          jsonBodyAssertions: assertions.jsonBody,
        },
        { executor: this.executor, signal: abort.signal },
      );
      const submissionResult =
        lease.requiredEngineVersion === LEGACY_HTTP_ENGINE_VERSION
          ? withoutTlsEvidence(result)
          : result;
      const serialized = this.client.serializeSubmission(
        lease,
        lease.requiredEngineVersion,
        submissionResult,
      );
      await this.submitWithRetry(lease, serialized, abort, authority);
    } catch (error) {
      if (
        error instanceof ProbeCoordinatorError &&
        (error.kind === 'STALE' || error.kind === 'AUTH')
      ) {
        abort.abort();
        if (error.kind === 'AUTH') this.stopping = true;
        return;
      }
      throw error;
    } finally {
      abort.abort();
      clearTimeout(executionDeadline);
      await renewal;
      this.activeAbort = null;
    }
  }

  private async submitWithRetry(
    lease: ProbeLeaseReferenceV1,
    serialized: string,
    abort: AbortController,
    authority: { expiresAt: number },
  ): Promise<void> {
    let delay = 250;
    while (!abort.signal.aborted) {
      if (Date.now() >= authority.expiresAt) {
        abort.abort();
        return;
      }
      try {
        await this.client.submitSerialized(lease, serialized, abort.signal);
        return;
      } catch (error) {
        if (!(error instanceof ProbeCoordinatorError) || error.kind !== 'TRANSIENT') throw error;
        await waitForDelay(delay, abort.signal);
        delay = Math.min(delay * 2, 2_000);
      }
    }
  }

  private async renewalLoop(
    lease: ProbeLeaseReferenceV1,
    abort: AbortController,
    authority: { expiresAt: number },
  ): Promise<void> {
    while (!abort.signal.aborted) {
      await waitForDelay(this.config.renewalIntervalMs, abort.signal);
      if (abort.signal.aborted) return;
      try {
        const renewed = await this.client.renew(lease, lease.requiredEngineVersion, abort.signal);
        authority.expiresAt = Date.parse(renewed);
      } catch (error) {
        if (
          error instanceof ProbeCoordinatorError &&
          (error.kind === 'AUTH' || error.kind === 'STALE')
        ) {
          abort.abort();
          if (error.kind === 'AUTH') this.stopping = true;
          return;
        }
      }
    }
  }

  private async heartbeatLoop(): Promise<void> {
    while (!this.stopping) {
      try {
        await this.client.heartbeat(
          HTTP_ENGINE_VERSION,
          this.config.heartbeatIntervalMs,
          this.lifecycleAbort.signal,
        );
      } catch (error) {
        if (error instanceof ProbeCoordinatorError && error.kind === 'AUTH') {
          this.stopping = true;
          this.lifecycleAbort.abort();
          this.activeAbort?.abort();
          return;
        }
      }
      await waitForDelay(this.config.heartbeatIntervalMs, this.lifecycleAbort.signal);
    }
  }

  private async claimCompatibleLease(): Promise<ProbeLeaseReferenceV1 | null> {
    const currentLease = await this.client.claim(HTTP_ENGINE_VERSION, this.lifecycleAbort.signal);
    if (currentLease) return currentLease;

    return this.client.claim(LEGACY_HTTP_ENGINE_VERSION, this.lifecycleAbort.signal);
  }
}

function withoutTlsEvidence(result: HttpCheckResult): HttpCheckResult {
  const legacyResult: HttpCheckResult = { ...result };
  delete legacyResult.tlsCertificates;
  return legacyResult;
}

export function waitForDelay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (milliseconds <= 0 || signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', finish);
      resolve();
    };
    const timer = setTimeout(finish, milliseconds);
    signal?.addEventListener('abort', finish, { once: true });
  });
}
