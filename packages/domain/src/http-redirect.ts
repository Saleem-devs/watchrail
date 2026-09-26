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

export class HttpRedirectDiagnosticsInvariantError extends Error {
  constructor() {
    super('Stored HTTP redirect diagnostics violate the persistence contract.');
    this.name = 'HttpRedirectDiagnosticsInvariantError';
  }
}

export function parseHttpRedirectHops(value: unknown): HttpRedirectHop[] {
  if (!Array.isArray(value)) throw new HttpRedirectDiagnosticsInvariantError();

  return value.map((hop, index) => parseHop(hop, index + 1));
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
