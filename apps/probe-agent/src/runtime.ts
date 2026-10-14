import { executeHttpCheck, NodeHttpExecutor, type HttpExecutor } from '@watchrail/check-engine';
import { HTTP_ENGINE_VERSION, parseResponseAssertions } from '@watchrail/domain';
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
          const lease = await this.client.claim(HTTP_ENGINE_VERSION);
          if (!lease) {
            failures = 0;
            await this.wait(this.config.pollIntervalMs, this.lifecycleAbort.signal);
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
          await this.wait(
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
    this.activeAbort = abort;
    const renewal = this.renewalLoop(lease, abort);
    try {
      const configuration = await this.client.configuration(lease, abort.signal);
      if (
        configuration.assignmentId !== lease.assignmentId ||
        configuration.configurationVersionId !== lease.configurationVersionId ||
        configuration.configurationVersionNumber !== lease.configurationVersionNumber ||
        configuration.executionPolicyVersion !== lease.executionPolicyVersion ||
        configuration.requiredEngineVersion !== HTTP_ENGINE_VERSION
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
          requestHeaders: configuration.requestHeaders,
          headerAssertions: assertions.headers,
          textBodyAssertions: assertions.textBody,
          jsonBodyAssertions: assertions.jsonBody,
        },
        { executor: this.executor },
      );
      const serialized = this.client.serializeSubmission(lease, HTTP_ENGINE_VERSION, result);
      await this.submitWithRetry(lease, serialized, abort.signal);
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
      await renewal;
      this.activeAbort = null;
    }
  }

  private async submitWithRetry(
    lease: ProbeLeaseReferenceV1,
    serialized: string,
    signal: AbortSignal,
  ): Promise<void> {
    let delay = 250;
    while (!signal.aborted) {
      try {
        await this.client.submitSerialized(lease, serialized);
        return;
      } catch (error) {
        if (!(error instanceof ProbeCoordinatorError) || error.kind !== 'TRANSIENT') throw error;
        await this.wait(delay, signal);
        delay = Math.min(delay * 2, 2_000);
      }
    }
  }

  private async renewalLoop(lease: ProbeLeaseReferenceV1, abort: AbortController): Promise<void> {
    while (!abort.signal.aborted) {
      await this.wait(this.config.renewalIntervalMs, abort.signal);
      if (abort.signal.aborted) return;
      try {
        await this.client.renew(lease, HTTP_ENGINE_VERSION);
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
        await this.client.heartbeat(HTTP_ENGINE_VERSION);
      } catch (error) {
        if (error instanceof ProbeCoordinatorError && error.kind === 'AUTH') {
          this.stopping = true;
          this.activeAbort?.abort();
          return;
        }
      }
      await this.wait(this.config.heartbeatIntervalMs, this.lifecycleAbort.signal);
    }
  }

  private wait(milliseconds: number, signal?: AbortSignal): Promise<void> {
    if (milliseconds <= 0 || signal?.aborted) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, milliseconds);
      signal?.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
    });
  }
}
