import type {
  HttpExecutionInput,
  HttpExecutionResult,
  HttpExecutor,
  HttpTargetFailure,
} from './types.js';

export interface NodeFetchHttpExecutorOptions {
  fetchImpl?: typeof globalThis.fetch;
  monotonicNow?: () => number;
}

/**
 * Executes one HTTP request with Node's built-in fetch implementation.
 *
 * Redirects are intentionally left in manual mode until Slice 4 owns safe
 * redirect traversal and SSRF validation. TLS verification remains at Node's
 * secure default because this adapter does not install a custom dispatcher or
 * disable certificate verification.
 */
export class NodeFetchHttpExecutor implements HttpExecutor {
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly monotonicNow: () => number;

  constructor(options: NodeFetchHttpExecutorOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.monotonicNow = options.monotonicNow ?? (() => performance.now());
  }

  async execute(input: HttpExecutionInput): Promise<HttpExecutionResult> {
    const startedAt = this.monotonicNow();

    let response: Response;

    try {
      response = await this.fetchImpl(input.url, {
        method: input.method,
        signal: input.signal,
        redirect: 'manual',
      });
    } catch (error) {
      const targetFailure = classifyFetchFailure(error);

      if (targetFailure !== null) {
        return targetFailure;
      }

      throw error;
    }

    const responseTimeMs = Math.max(0, this.monotonicNow() - startedAt);

    if (response.body !== null) {
      try {
        await response.body.cancel();
      } catch {
        // Response evidence is already valid. Body cleanup failure must not
        // erase or change the target classification.
      }
    }

    return {
      type: 'RESPONSE',
      statusCode: response.status,
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
