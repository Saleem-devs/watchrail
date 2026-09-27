import { Readable } from 'node:stream';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';
import type {
  HttpBodyCapture,
  HttpExecutionInput,
  HttpExecutionResult,
  HttpExecutor,
  HttpTargetFailure,
} from './types.js';
import { HTTP_BODY_CAPTURE_LIMIT_BYTES } from './types.js';
import {
  formatHttpRedirectOrigin,
  type HttpRedirectEndpoint,
  type HttpRedirectHop,
} from '@watchrail/domain';
import {
  InvalidHttpTargetError,
  ProhibitedDestinationError,
  resolveSafeHttpTarget,
  validateHttpTargetUrl,
  type DnsResolver,
} from './safe-http-target.js';
import {
  EncodedBodyTooLargeError,
  UndiciPinnedHttpTransport,
  type HttpTransportResponse,
  type PinnedHttpTransport,
} from './undici-http-transport.js';

export interface NodeHttpExecutorOptions {
  resolver?: DnsResolver;
  transport?: PinnedHttpTransport;
  monotonicNow?: () => number;
}

const REDIRECT_STATUS_CODES = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 5;
type RedirectStatusCode = 301 | 302 | 303 | 307 | 308;

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
    const endpoints = new Map<string, HttpRedirectEndpoint>();
    const redirects: HttpRedirectHop[] = [];
    const publishEvidence = (): void => {
      input.onEvidence?.({ redirects: [...redirects] });
    };
    let currentUrl: string | URL = input.url;
    let redirectsFollowed = 0;
    let headersAttached = true;
    let pendingHopIndex: number | null = null;

    const endpointFor = (url: URL): HttpRedirectEndpoint => {
      const identity = redirectIdentity(url);
      const existing = endpoints.get(identity);
      if (existing) return existing;
      const endpoint = { targetId: endpoints.size + 1, origin: formatHttpRedirectOrigin(url) };
      endpoints.set(identity, endpoint);
      return endpoint;
    };

    while (true) {
      const hopStartedAt = this.monotonicNow();
      let target;
      let response;

      try {
        target = await resolveSafeHttpTarget(currentUrl, {
          signal: input.signal,
          ...(this.resolver ? { resolver: this.resolver } : {}),
        });

        visited.add(redirectIdentity(target.url));
        if (pendingHopIndex !== null) {
          const pending = redirects[pendingHopIndex];
          if (pending) {
            redirects[pendingHopIndex] = {
              ...pending,
              headers: headersAttached ? 'PRESERVED' : 'STRIPPED',
            };
            publishEvidence();
          }
          pendingHopIndex = null;
        }
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
            redirects,
          };
        }

        const targetFailure = classifyFetchFailure(error, target?.url.protocol === 'https:');
        if (targetFailure !== null) return { ...targetFailure, redirects };
        throw error;
      }

      const responseReceivedAt = this.monotonicNow();
      const responseTimeMs = Math.max(0, responseReceivedAt - startedAt);
      const hopResponseTimeMs = Math.max(0, responseReceivedAt - hopStartedAt);

      if (!isRedirectStatus(response.statusCode)) {
        const body = await observeFinalBody(response, input);
        return {
          type: 'RESPONSE',
          statusCode: response.statusCode,
          responseTimeMs,
          headers: response.headers,
          body,
          redirects,
        };
      }

      if (input.followRedirects === false) {
        const body = await observeFinalBody(response, input);
        return {
          type: 'RESPONSE',
          statusCode: response.statusCode,
          responseTimeMs,
          headers: response.headers,
          body,
          redirects: [],
        };
      }

      await discardResponseBody(response);

      const source = endpointFor(target.url);

      if (response.location === null) {
        redirects.push(createHop(response.statusCode, source, null, hopResponseTimeMs, redirects));
        publishEvidence();
        return redirectFailure(
          'MISSING_REDIRECT_LOCATION',
          response.statusCode,
          responseTimeMs,
          redirects,
        );
      }

      let nextUrl: URL;
      try {
        if (response.location.trim() === '') throw new InvalidHttpTargetError('Empty location.');
        nextUrl = validateHttpTargetUrl(new URL(response.location, target.url));
      } catch {
        redirects.push(createHop(response.statusCode, source, null, hopResponseTimeMs, redirects));
        publishEvidence();
        return redirectFailure(
          'INVALID_REDIRECT_LOCATION',
          response.statusCode,
          responseTimeMs,
          redirects,
        );
      }

      const destination = endpointFor(nextUrl);
      redirects.push(
        createHop(response.statusCode, source, destination, hopResponseTimeMs, redirects),
      );
      publishEvidence();

      if (target.url.protocol === 'https:' && nextUrl.protocol === 'http:') {
        return redirectFailure('INSECURE_REDIRECT', response.statusCode, responseTimeMs, redirects);
      }

      const identity = redirectIdentity(nextUrl);
      if (visited.has(identity)) {
        return redirectFailure('REDIRECT_LOOP', response.statusCode, responseTimeMs, redirects);
      }

      if (redirectsFollowed >= MAX_REDIRECTS) {
        return redirectFailure(
          'TOO_MANY_REDIRECTS',
          response.statusCode,
          responseTimeMs,
          redirects,
        );
      }

      redirectsFollowed += 1;
      if (target.url.origin !== nextUrl.origin) headersAttached = false;
      pendingHopIndex = redirects.length - 1;
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
  redirects: readonly HttpRedirectHop[],
): HttpExecutionResult {
  return { type: 'REDIRECT_FAILURE', reason, statusCode, responseTimeMs, redirects };
}

function createHop(
  statusCode: RedirectStatusCode,
  source: HttpRedirectEndpoint,
  destination: HttpRedirectEndpoint | null,
  responseTimeMs: number,
  existing: readonly HttpRedirectHop[],
): HttpRedirectHop {
  return {
    sequence: existing.length + 1,
    statusCode,
    source,
    destination,
    responseTimeMs,
    headers: 'NOT_SENT',
  };
}

function isRedirectStatus(statusCode: number): statusCode is RedirectStatusCode {
  return REDIRECT_STATUS_CODES.has(statusCode);
}

async function discardResponseBody(response: { discardBody(): Promise<void> }): Promise<void> {
  try {
    await response.discardBody();
  } catch {
    // Response headers are already valid evidence. Cleanup failure must not
    // erase or change the target classification.
  }
}

async function observeFinalBody(
  response: HttpTransportResponse,
  input: HttpExecutionInput,
): Promise<HttpBodyCapture> {
  if (input.method === 'HEAD' || input.captureResponseBody !== true) {
    await discardResponseBody(response);
    return { state: 'NOT_REQUESTED' };
  }

  const contentLength = singleHeaderValue(response.headers, 'content-length');
  if (contentLength !== null && isContentLengthOverLimit(contentLength)) {
    await discardResponseBody(response);
    return { state: 'UNAVAILABLE', reason: 'BODY_TOO_LARGE' };
  }

  const encoding = parseContentEncoding(response.headers);
  if (encoding === null) {
    await discardResponseBody(response);
    return { state: 'UNAVAILABLE', reason: 'UNSUPPORTED_CONTENT_ENCODING' };
  }

  const charset = parseCharset(response.headers);
  if (charset === null) {
    await discardResponseBody(response);
    return { state: 'UNAVAILABLE', reason: 'UNSUPPORTED_CHARSET' };
  }

  try {
    const encoded = await response.captureEncodedBody(HTTP_BODY_CAPTURE_LIMIT_BYTES);
    const decoded = await decodeBody(encoded, encoding);
    return { state: 'CAPTURED', text: new TextDecoder('utf-8', { fatal: true }).decode(decoded) };
  } catch (error) {
    if (input.signal.aborted) throw error;
    if (error instanceof EncodedBodyTooLargeError || error instanceof DecodedBodyTooLargeError) {
      return { state: 'UNAVAILABLE', reason: 'BODY_TOO_LARGE' };
    }
    return { state: 'UNAVAILABLE', reason: 'BODY_READ_FAILED' };
  }
}

type SupportedContentEncoding = 'identity' | 'gzip' | 'deflate' | 'br';

function parseContentEncoding(
  headers: readonly { name: string; values: readonly string[] }[],
): SupportedContentEncoding | null {
  const values = headers
    .filter((header) => header.name === 'content-encoding')
    .flatMap((header) => header.values)
    .map((value) => value.trim().toLowerCase())
    .filter((value) => value !== '');
  if (values.length === 0) return 'identity';
  if (values.length !== 1 || values[0]?.includes(',') === true) return null;
  const value = values[0];
  return value === 'identity' || value === 'gzip' || value === 'deflate' || value === 'br'
    ? value
    : null;
}

function parseCharset(
  headers: readonly { name: string; values: readonly string[] }[],
): 'utf-8' | null {
  const contentType = singleHeaderValue(headers, 'content-type');
  if (contentType === null) return 'utf-8';
  const matches = [...contentType.matchAll(/(?:^|;)\s*charset\s*=\s*(?:"([^"]*)"|([^;\s]*))/gi)];
  if (matches.length === 0) return 'utf-8';
  if (matches.length !== 1) return null;
  const value = (matches[0]?.[1] ?? matches[0]?.[2] ?? '').toLowerCase();
  return value === 'utf-8' || value === 'utf8' ? 'utf-8' : null;
}

function singleHeaderValue(
  headers: readonly { name: string; values: readonly string[] }[],
  name: string,
): string | null {
  const values = headers
    .filter((header) => header.name === name)
    .flatMap((header) => header.values);
  return values.length === 1 ? (values[0] ?? null) : null;
}

function isContentLengthOverLimit(value: string): boolean {
  if (!/^[0-9]+$/.test(value)) return false;
  try {
    return BigInt(value) > BigInt(HTTP_BODY_CAPTURE_LIMIT_BYTES);
  } catch {
    return false;
  }
}

class DecodedBodyTooLargeError extends Error {}

async function decodeBody(
  encoded: Uint8Array,
  encoding: SupportedContentEncoding,
): Promise<Uint8Array> {
  if (encoding === 'identity') return encoded;
  const decoder =
    encoding === 'gzip'
      ? createGunzip()
      : encoding === 'deflate'
        ? createInflate()
        : createBrotliDecompress();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for await (const chunk of Readable.from([encoded]).pipe(decoder)) {
      const bytes = decodedBodyChunk(chunk);
      length += bytes.byteLength;
      if (length > HTTP_BODY_CAPTURE_LIMIT_BYTES) {
        decoder.destroy();
        throw new DecodedBodyTooLargeError();
      }
      chunks.push(bytes);
    }
  } catch (error) {
    decoder.destroy();
    throw error;
  }
  return Buffer.concat(chunks, length);
}

function decodedBodyChunk(value: unknown): Uint8Array {
  if (typeof value === 'string') return Buffer.from(value);
  if (value instanceof Uint8Array) return value;
  throw new TypeError('HTTP body decoder emitted an unsupported chunk.');
}

function classifyFetchFailure(error: unknown, tlsAttempted: boolean): HttpTargetFailure | null {
  const code = findErrorCode(error);

  switch (code) {
    case 'ENOTFOUND':
      return {
        type: 'TARGET_FAILURE',
        stage: 'DNS',
        reason: 'NAME_NOT_FOUND',
        redirects: [],
      };
    case 'ECONNREFUSED':
      return {
        type: 'TARGET_FAILURE',
        stage: 'CONNECT',
        reason: 'CONNECTION_REFUSED',
        redirects: [],
      };
    default:
      return classifyTlsFailure(code, tlsAttempted);
  }
}

function classifyTlsFailure(code: string | null, tlsAttempted: boolean): HttpTargetFailure | null {
  if (!tlsAttempted) return null;

  switch (code) {
    case 'CERT_HAS_EXPIRED':
      return tlsFailure('CERTIFICATE_EXPIRED');
    case 'CERT_NOT_YET_VALID':
      return tlsFailure('CERTIFICATE_NOT_YET_VALID');
    case 'ERR_TLS_CERT_ALTNAME_INVALID':
      return tlsFailure('CERTIFICATE_HOSTNAME_MISMATCH');
    case 'DEPTH_ZERO_SELF_SIGNED_CERT':
    case 'SELF_SIGNED_CERT_IN_CHAIN':
    case 'UNABLE_TO_VERIFY_LEAF_SIGNATURE':
    case 'UNABLE_TO_GET_ISSUER_CERT':
    case 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY':
    case 'CERT_UNTRUSTED':
    case 'CERT_REVOKED':
    case 'CERT_CHAIN_TOO_LONG':
    case 'INVALID_CA':
    case 'PATH_LENGTH_EXCEEDED':
    case 'INVALID_PURPOSE':
    case 'CERT_REJECTED':
      return tlsFailure('CERTIFICATE_UNTRUSTED');
    case 'EPROTO':
    case 'ERR_TLS_DH_PARAM_SIZE':
    case 'ERR_TLS_HANDSHAKE_TIMEOUT':
      return tlsFailure('TLS_HANDSHAKE_FAILED');
    default:
      return code?.startsWith('ERR_SSL_') === true ? tlsFailure('TLS_HANDSHAKE_FAILED') : null;
  }
}

function tlsFailure(
  reason: Extract<HttpTargetFailure, { stage: 'TLS' }>['reason'],
): HttpTargetFailure {
  return { type: 'TARGET_FAILURE', stage: 'TLS', reason, redirects: [] };
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
