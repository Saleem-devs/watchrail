import type {
  HttpExecutionInput,
  HttpExecutionResult,
  HttpExecutor,
  HttpTargetFailure,
} from './types.js';
import {
  InvalidHttpTargetError,
  ProhibitedDestinationError,
  resolveSafeHttpTarget,
  type DnsResolver,
} from './safe-http-target.js';
import { UndiciPinnedHttpTransport, type PinnedHttpTransport } from './undici-http-transport.js';

export interface NodeHttpExecutorOptions {
  resolver?: DnsResolver;
  transport?: PinnedHttpTransport;
  monotonicNow?: () => number;
}

/**
 * Executes one HTTP request through an SSRF-safe, address-pinned transport.
 *
 * Redirects are intentionally left in manual mode until Slice 4 owns safe
 * redirect traversal. TLS verification remains at Node's secure default.
 */
export class NodeHttpExecutor implements HttpExecutor {
  private readonly resolver: DnsResolver | undefined;
  private readonly transport: PinnedHttpTransport;
  private readonly monotonicNow: () => number;

  constructor(options: NodeHttpExecutorOptions = {}) {
    this.resolver = options.resolver;
    this.transport = options.transport ?? new UndiciPinnedHttpTransport();
    this.monotonicNow = options.monotonicNow ?? (() => performance.now());
  }

  async execute(input: HttpExecutionInput): Promise<HttpExecutionResult> {
    const startedAt = this.monotonicNow();

    let response;

    try {
      const target = await resolveSafeHttpTarget(input.url, {
        signal: input.signal,
        ...(this.resolver ? { resolver: this.resolver } : {}),
      });

      response = await this.transport.request({
        target,
        method: input.method,
        signal: input.signal,
      });
    } catch (error) {
      if (error instanceof ProhibitedDestinationError || error instanceof InvalidHttpTargetError) {
        return {
          type: 'POLICY_REJECTION',
          stage: 'DNS',
          reason: 'PROHIBITED_DESTINATION',
        };
      }

      const targetFailure = classifyFetchFailure(error);

      if (targetFailure !== null) {
        return targetFailure;
      }

      throw error;
    }

    const responseTimeMs = Math.max(0, this.monotonicNow() - startedAt);

    try {
      await response.discardBody();
    } catch {
      // Response evidence is already valid. Body cleanup failure must not
      // erase or change the target classification.
    }

    return {
      type: 'RESPONSE',
      statusCode: response.statusCode,
      responseTimeMs,
    };
  }
}

function classifyFetchFailure(error: unknown): HttpTargetFailure | null {
  const code = findErrorCode(error);

  switch (code) {
    case 'ENOTFOUND':
      return {
        type: 'TARGET_FAILURE',
        stage: 'DNS',
        reason: 'NAME_NOT_FOUND',
      };
    case 'ECONNREFUSED':
      return {
        type: 'TARGET_FAILURE',
        stage: 'CONNECT',
        reason: 'CONNECTION_REFUSED',
      };
    case 'CERT_HAS_EXPIRED':
      return {
        type: 'TARGET_FAILURE',
        stage: 'TLS',
        reason: 'CERTIFICATE_EXPIRED',
      };
    default:
      return null;
  }
}

function findErrorCode(error: unknown): string | null {
  const seen = new Set<unknown>();
  let current: unknown = error;

  while (isRecord(current) && !seen.has(current)) {
    seen.add(current);

    if (typeof current.code === 'string') {
      return current.code;
    }

    current = current.cause;
  }

  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
