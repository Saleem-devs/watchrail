export type RedirectHeaderDisposition = 'PRESERVED' | 'STRIPPED' | 'NOT_SENT';

export interface HttpRedirectEndpoint {
  targetId: number;
  origin: string;
}

export interface HttpRedirectHop {
  sequence: number;
  statusCode: 301 | 302 | 303 | 307 | 308;
  source: HttpRedirectEndpoint;
  destination: HttpRedirectEndpoint | null;
  responseTimeMs: number;
  headers: RedirectHeaderDisposition;
}

const REDIRECT_STATUS_CODES = new Set([301, 302, 303, 307, 308]);
const HEADER_DISPOSITIONS = new Set(['PRESERVED', 'STRIPPED', 'NOT_SENT']);
const MAX_RECORDED_REDIRECT_HOPS = 6;

export class HttpRedirectDiagnosticsInvariantError extends Error {
  constructor() {
    super('Stored HTTP redirect diagnostics violate the persistence contract.');
    this.name = 'HttpRedirectDiagnosticsInvariantError';
  }
}

export function parseHttpRedirectHops(value: unknown): HttpRedirectHop[] {
  if (!Array.isArray(value) || value.length > MAX_RECORDED_REDIRECT_HOPS) {
    throw new HttpRedirectDiagnosticsInvariantError();
  }

  const hops = value.map((hop, index) => parseHop(hop, index + 1));
  assertValidChain(hops);
  return hops;
}

export function formatHttpRedirectOrigin(url: URL): string {
  const port = url.port || (url.protocol === 'https:' ? '443' : '80');
  const hostname =
    url.hostname.includes(':') && !url.hostname.startsWith('[')
      ? `[${url.hostname}]`
      : url.hostname;
  return `${url.protocol}//${hostname}:${port}`;
}

function parseHop(value: unknown, expectedSequence: number): HttpRedirectHop {
  if (
    !isExactRecord(value, [
      'sequence',
      'statusCode',
      'source',
      'destination',
      'responseTimeMs',
      'headers',
    ])
  ) {
    throw new HttpRedirectDiagnosticsInvariantError();
  }

  if (
    value.sequence !== expectedSequence ||
    !isRedirectStatus(value.statusCode) ||
    typeof value.responseTimeMs !== 'number' ||
    !Number.isFinite(value.responseTimeMs) ||
    value.responseTimeMs < 0 ||
    typeof value.headers !== 'string' ||
    !HEADER_DISPOSITIONS.has(value.headers)
  ) {
    throw new HttpRedirectDiagnosticsInvariantError();
  }

  return {
    sequence: value.sequence,
    statusCode: value.statusCode,
    source: parseEndpoint(value.source),
    destination: value.destination === null ? null : parseEndpoint(value.destination),
    responseTimeMs: value.responseTimeMs,
    headers: value.headers as RedirectHeaderDisposition,
  };
}

function parseEndpoint(value: unknown): HttpRedirectEndpoint {
  if (!isExactRecord(value, ['targetId', 'origin'])) {
    throw new HttpRedirectDiagnosticsInvariantError();
  }

  if (!Number.isInteger(value.targetId) || (value.targetId as number) < 1) {
    throw new HttpRedirectDiagnosticsInvariantError();
  }
  if (typeof value.origin !== 'string' || !isCanonicalHttpOrigin(value.origin)) {
    throw new HttpRedirectDiagnosticsInvariantError();
  }

  return { targetId: value.targetId as number, origin: value.origin };
}

function assertValidChain(hops: readonly HttpRedirectHop[]): void {
  const originsByTargetId = new Map<number, string>();

  const registerEndpoint = (endpoint: HttpRedirectEndpoint): void => {
    const existingOrigin = originsByTargetId.get(endpoint.targetId);
    if (existingOrigin !== undefined && existingOrigin !== endpoint.origin) {
      throw new HttpRedirectDiagnosticsInvariantError();
    }
    originsByTargetId.set(endpoint.targetId, endpoint.origin);
  };

  hops.forEach((hop, index) => {
    registerEndpoint(hop.source);
    if (hop.destination !== null) registerEndpoint(hop.destination);

    const terminal = index === hops.length - 1;
    if (hop.destination === null && hop.headers !== 'NOT_SENT') {
      throw new HttpRedirectDiagnosticsInvariantError();
    }
    if (hop.headers === 'NOT_SENT' && !terminal) {
      throw new HttpRedirectDiagnosticsInvariantError();
    }

    if (index === 0) return;
    const previous = hops[index - 1];
    if (
      previous === undefined ||
      previous.destination === null ||
      previous.headers === 'NOT_SENT' ||
      !sameEndpoint(previous.destination, hop.source)
    ) {
      throw new HttpRedirectDiagnosticsInvariantError();
    }
  });
}

function sameEndpoint(left: HttpRedirectEndpoint, right: HttpRedirectEndpoint): boolean {
  return left.targetId === right.targetId && left.origin === right.origin;
}

function isCanonicalHttpOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    return (
      (url.protocol === 'http:' || url.protocol === 'https:') &&
      url.username === '' &&
      url.password === '' &&
      url.pathname === '/' &&
      url.search === '' &&
      url.hash === '' &&
      formatHttpRedirectOrigin(url) === origin
    );
  } catch {
    return false;
  }
}

function isRedirectStatus(value: unknown): value is HttpRedirectHop['statusCode'] {
  return typeof value === 'number' && REDIRECT_STATUS_CODES.has(value);
}

function isExactRecord(
  value: unknown,
  expectedKeys: readonly string[],
): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const keys = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  return keys.length === expected.length && keys.every((key, index) => key === expected[index]);
}
