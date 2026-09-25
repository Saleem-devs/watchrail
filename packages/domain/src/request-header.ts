export interface EncryptedHeaderValueV1 {
  version: 1;
  algorithm: 'AES-256-GCM';
  keyId: string;
  iv: string;
  ciphertext: string;
  authTag: string;
}

export type StoredRequestHeader =
  | { name: string; sensitive: false; value: string }
  | { name: string; sensitive: true; encryptedValue: EncryptedHeaderValueV1 };

export type RequestHeaderUpdate =
  | { name: string; sensitive: false; value: string }
  | { name: string; sensitive: true; value: string }
  | { name: string; sensitive: true; retain: true };

export type ResolvedRequestHeader = { name: string; value: string };

const FORCED_SENSITIVE_HEADERS = new Set([
  'authorization',
  'cookie',
  'x-api-key',
  'api-key',
  'x-auth-token',
]);

const PROHIBITED_HEADERS = new Set([
  'host',
  'content-length',
  'connection',
  'transfer-encoding',
  'te',
  'trailer',
  'upgrade',
  'proxy-connection',
  'proxy-authorization',
  'expect',
]);

const HTTP_TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

export class RequestHeaderInputError extends Error {
  constructor(readonly issues: string[]) {
    super('Request headers are invalid.');
    this.name = 'RequestHeaderInputError';
  }
}

export class StoredRequestHeadersInvariantError extends Error {
  constructor() {
    super('Stored request headers violate the persistence contract.');
    this.name = 'StoredRequestHeadersInvariantError';
  }
}

export function parseStoredRequestHeaders(value: unknown): StoredRequestHeader[] {
  if (!Array.isArray(value)) throw new StoredRequestHeadersInvariantError();

  const seen = new Set<string>();
  const parsed = value.map((candidate) => parseStoredRequestHeader(candidate));
  for (const header of parsed) {
    if (seen.has(header.name)) throw new StoredRequestHeadersInvariantError();
    seen.add(header.name);
  }
  return parsed;
}

export function normalizeRequestHeaderUpdates(value: unknown): RequestHeaderUpdate[] {
  if (!Array.isArray(value)) throw new RequestHeaderInputError(['Headers must be an array.']);

  const issues: string[] = [];
  const seen = new Set<string>();
  const normalized: RequestHeaderUpdate[] = [];

  for (const [index, candidate] of value.entries()) {
    if (!isRecord(candidate) || typeof candidate.name !== 'string') {
      issues.push(`Header ${index + 1} must have a name.`);
      continue;
    }

    const name = candidate.name.trim().toLowerCase();
    if (!HTTP_TOKEN.test(name)) {
      issues.push(`Header ${index + 1} has an invalid name.`);
      continue;
    }
    if (PROHIBITED_HEADERS.has(name)) {
      issues.push(`${name} is controlled by Watchrail and cannot be configured.`);
      continue;
    }
    if (seen.has(name)) {
      issues.push(`${name} is configured more than once.`);
      continue;
    }
    seen.add(name);

    const sensitive = candidate.sensitive === true || FORCED_SENSITIVE_HEADERS.has(name);
    if (candidate.retain === true) {
      if (!sensitive) issues.push(`${name} cannot retain a non-sensitive value.`);
      else normalized.push({ name, sensitive: true, retain: true });
      continue;
    }

    if (typeof candidate.value !== 'string') {
      issues.push(`${name} must have a string value.`);
      continue;
    }
    if (!isValidHeaderValue(candidate.value)) {
      issues.push(`${name} contains invalid control characters.`);
      continue;
    }

    normalized.push(
      sensitive
        ? { name, sensitive: true, value: candidate.value }
        : { name, sensitive: false, value: candidate.value },
    );
  }

  if (issues.length > 0) throw new RequestHeaderInputError(issues);
  return normalized;
}

export function assertNoRetainedHeaders(headers: readonly RequestHeaderUpdate[]): void {
  if (headers.some((header) => 'retain' in header)) {
    throw new RequestHeaderInputError(['retain is only valid when updating an existing secret.']);
  }
}

function isValidHeaderValue(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code === 10 || code === 13 || (code < 32 && code !== 9) || code === 127) return false;
  }
  return true;
}

function parseStoredRequestHeader(value: unknown): StoredRequestHeader {
  if (
    !isRecord(value) ||
    typeof value.name !== 'string' ||
    value.name !== value.name.toLowerCase()
  ) {
    throw new StoredRequestHeadersInvariantError();
  }
  if (!HTTP_TOKEN.test(value.name) || PROHIBITED_HEADERS.has(value.name)) {
    throw new StoredRequestHeadersInvariantError();
  }

  if (value.sensitive === false) {
    if (
      !hasExactKeys(value, ['name', 'sensitive', 'value']) ||
      FORCED_SENSITIVE_HEADERS.has(value.name) ||
      typeof value.value !== 'string' ||
      !isValidHeaderValue(value.value)
    ) {
      throw new StoredRequestHeadersInvariantError();
    }
    return { name: value.name, sensitive: false, value: value.value };
  }

  if (
    value.sensitive !== true ||
    !hasExactKeys(value, ['name', 'sensitive', 'encryptedValue']) ||
    !isEncryptedHeaderValueV1(value.encryptedValue)
  ) {
    throw new StoredRequestHeadersInvariantError();
  }
  return { name: value.name, sensitive: true, encryptedValue: value.encryptedValue };
}

function isEncryptedHeaderValueV1(value: unknown): value is EncryptedHeaderValueV1 {
  return (
    isRecord(value) &&
    hasExactKeys(value, ['version', 'algorithm', 'keyId', 'iv', 'ciphertext', 'authTag']) &&
    value.version === 1 &&
    value.algorithm === 'AES-256-GCM' &&
    typeof value.keyId === 'string' &&
    value.keyId.length > 0 &&
    value.keyId.length <= 120 &&
    typeof value.iv === 'string' &&
    base64UrlByteLength(value.iv) === 12 &&
    typeof value.ciphertext === 'string' &&
    base64UrlByteLength(value.ciphertext) !== null &&
    typeof value.authTag === 'string' &&
    base64UrlByteLength(value.authTag) === 16
  );
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === expected.length && actual.every((key) => expected.includes(key));
}

function base64UrlByteLength(value: string): number | null {
  if (!/^[A-Za-z0-9_-]*$/u.test(value) || value.length % 4 === 1) return null;

  try {
    const padded = value
      .replace(/-/gu, '+')
      .replace(/_/gu, '/')
      .padEnd(value.length + ((4 - (value.length % 4)) % 4), '=');
    const decoded = atob(padded);
    const canonical = btoa(decoded).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '');
    return canonical === value ? decoded.length : null;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
