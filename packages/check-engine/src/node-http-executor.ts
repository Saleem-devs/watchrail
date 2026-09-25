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
  validateHttpTargetUrl,
  type DnsResolver,
} from './safe-http-target.js';
import { UndiciPinnedHttpTransport, type PinnedHttpTransport } from './undici-http-transport.js';

export interface NodeHttpExecutorOptions {
  resolver?: DnsResolver;
  transport?: PinnedHttpTransport;
  monotonicNow?: () => number;
}

const REDIRECT_STATUS_CODES = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 5;

/**
 * Executes an HTTP check through an SSRF-safe, address-pinned transport.
 * Every redirect target is independently validated, resolved, and pinned.
 * TLS verification remains at Node's secure default.
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
    const visited = new Set<string>();
    let currentUrl: string | URL = input.url;
    let redirectsFollowed = 0;
    let headersAttached = true;

    while (true) {
      let target;
      let response;

      try {
        target = await resolveSafeHttpTarget(currentUrl, {
          signal: input.signal,
          ...(this.resolver ? { resolver: this.resolver } : {}),
        });

        visited.add(redirectIdentity(target.url));
        response = await this.transport.request({
          target,
          method: input.method,
          signal: input.signal,
          headers: headersAttached ? (input.requestHeaders ?? []) : [],
        });
      } catch (error) {
        if (
          error instanceof ProhibitedDestinationError ||
          error instanceof InvalidHttpTargetError
        ) {
          return {
            type: 'POLICY_REJECTION',
            stage: 'DNS',
            reason: 'PROHIBITED_DESTINATION',
          };
        }

        const targetFailure = classifyFetchFailure(error);
        if (targetFailure !== null) return targetFailure;
        throw error;
      }

      const responseTimeMs = Math.max(0, this.monotonicNow() - startedAt);
      await discardResponseBody(response);

      if (!REDIRECT_STATUS_CODES.has(response.statusCode)) {
        return { type: 'RESPONSE', statusCode: response.statusCode, responseTimeMs };
      }

      if (response.location === null) {
        return redirectFailure('MISSING_REDIRECT_LOCATION', response.statusCode, responseTimeMs);
      }

      let nextUrl: URL;
      try {
        if (response.location.trim() === '') throw new InvalidHttpTargetError('Empty location.');
        nextUrl = validateHttpTargetUrl(new URL(response.location, target.url));
      } catch {
        return redirectFailure('INVALID_REDIRECT_LOCATION', response.statusCode, responseTimeMs);
      }

      if (target.url.protocol === 'https:' && nextUrl.protocol === 'http:') {
        return redirectFailure('INSECURE_REDIRECT', response.statusCode, responseTimeMs);
      }

      const identity = redirectIdentity(nextUrl);
      if (visited.has(identity)) {
        return redirectFailure('REDIRECT_LOOP', response.statusCode, responseTimeMs);
      }

      if (redirectsFollowed >= MAX_REDIRECTS) {
        return redirectFailure('TOO_MANY_REDIRECTS', response.statusCode, responseTimeMs);
      }

      redirectsFollowed += 1;
      if (target.url.origin !== nextUrl.origin) headersAttached = false;
      currentUrl = nextUrl;
    }
  }
}

function redirectIdentity(url: URL): string {
  const normalized = new URL(url);
  normalized.hash = '';
  return normalized.href;
}

function redirectFailure(
  reason:
    | 'REDIRECT_LOOP'
    | 'TOO_MANY_REDIRECTS'
    | 'MISSING_REDIRECT_LOCATION'
    | 'INVALID_REDIRECT_LOCATION'
    | 'INSECURE_REDIRECT',
  statusCode: number,
  responseTimeMs: number,
): HttpExecutionResult {
  return { type: 'REDIRECT_FAILURE', reason, statusCode, responseTimeMs };
}

async function discardResponseBody(response: { discardBody(): Promise<void> }): Promise<void> {
  try {
    await response.discardBody();
  } catch {
    // Response headers are already valid evidence. Cleanup failure must not
    // erase or change the target classification.
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
