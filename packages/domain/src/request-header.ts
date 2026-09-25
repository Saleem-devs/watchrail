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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
