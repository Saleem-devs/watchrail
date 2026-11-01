import {
  executeHttpCheck,
  executeDnsCheck,
  executeTcpCheck,
  NodeDnsQueryResolver,
  NodeHttpExecutor,
  NodeTcpConnector,
  type HttpCheckResult,
  type HttpExecutor,
  type DnsQueryResolver,
  type TcpConnector,
} from '@watchrail/check-engine';
import {
  HTTP_ENGINE_VERSION,
  LEGACY_HTTP_ENGINE_VERSION,
  TCP_ENGINE_VERSION,
  DNS_ENGINE_VERSION,
  PROBE_MAX_EXECUTION_MS,
  parseResponseAssertions,
  probeEngineSupports,
} from '@watchrail/domain';
import type {
  ProbeExecutionConfigurationV1,
  ProbeLeaseReferenceV1,
  TcpProbeExecutionConfigurationV1,
  DnsProbeExecutionConfigurationV1,
} from '@watchrail/contracts';
import { ProbeCoordinatorError } from './coordinator-client.js';
import type { ProbeCoordinatorClient } from './coordinator-client.js';
import type { ProbeAgentConfig } from './config.js';

export class ProbeAgentRuntime {
  private static readonly legacyClaimFallbackIntervalMs = 30_000;
  private stopping = false;
  private activeAbort: AbortController | null = null;
  private readonly lifecycleAbort = new AbortController();
  private lastLegacyClaimFallbackAt = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly client: ProbeCoordinatorClient,
    private readonly config: ProbeAgentConfig,
    private readonly executor: HttpExecutor = new NodeHttpExecutor(),
    private readonly tcpConnector: TcpConnector = new NodeTcpConnector(),
    private readonly dnsResolver: DnsQueryResolver = new NodeDnsQueryResolver(),
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
        !probeEngineSupports(DNS_ENGINE_VERSION, configuration.requiredEngineVersion)
      ) {
        throw new ProbeCoordinatorError('INVALID');
      }
      const result = isDnsConfiguration(configuration)
        ? await executeDnsCheck(
            {
              name: configuration.name,
              recordType: configuration.recordType,
              expectedValues: configuration.expectedValues,
              timeoutMs: configuration.timeoutMs,
            },
            { resolver: this.dnsResolver, signal: abort.signal },
          )
        : isTcpConfiguration(configuration)
          ? await executeTcpCheck(
              {
                host: configuration.host,
                port: configuration.port,
                timeoutMs: configuration.timeoutMs,
              },
              { connector: this.tcpConnector, signal: abort.signal },
            )
          : await executeHttpConfiguration(configuration, this.executor, abort.signal);
      const submissionResult =
        lease.requiredEngineVersion === LEGACY_HTTP_ENGINE_VERSION && 'statusCode' in result
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
          DNS_ENGINE_VERSION,
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
    const dnsLease = await this.client.claim(DNS_ENGINE_VERSION, this.lifecycleAbort.signal);
    if (dnsLease) return dnsLease;

    const now = Date.now();
    if (now - this.lastLegacyClaimFallbackAt < ProbeAgentRuntime.legacyClaimFallbackIntervalMs) {
      return null;
    }
    this.lastLegacyClaimFallbackAt = now;

    const tcpLease = await this.client.claim(TCP_ENGINE_VERSION, this.lifecycleAbort.signal);
    if (tcpLease) return tcpLease;
    const currentLease = await this.client.claim(HTTP_ENGINE_VERSION, this.lifecycleAbort.signal);
    if (currentLease) return currentLease;

    return this.client.claim(LEGACY_HTTP_ENGINE_VERSION, this.lifecycleAbort.signal);
  }
}

function isDnsConfiguration(
  configuration: ProbeExecutionConfigurationV1,
): configuration is DnsProbeExecutionConfigurationV1 {
  return 'type' in configuration && configuration.type === 'DNS';
}

function isTcpConfiguration(
  configuration: ProbeExecutionConfigurationV1,
): configuration is TcpProbeExecutionConfigurationV1 {
  return 'type' in configuration && configuration.type === 'TCP';
}

async function executeHttpConfiguration(
  configuration: Exclude<
    Awaited<ReturnType<ProbeCoordinatorClient['configuration']>>,
    { type: 'TCP' } | { type: 'DNS' }
  >,
  executor: HttpExecutor,
  signal: AbortSignal,
): Promise<HttpCheckResult> {
  const assertions = parseResponseAssertions(configuration.assertions, configuration.method);
  return executeHttpCheck(
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
    { executor, signal },
  );
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
