import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';

export const WEBHOOK_SIGNING_SECRET_LIMITS = { minBytes: 32, maxBytes: 512 } as const;

export interface EncryptedWebhookSigningSecretV1 {
  version: 1;
  algorithm: 'AES-256-GCM';
  keyId: string;
  iv: string;
  ciphertext: string;
  authTag: string;
}

export interface WebhookSigningSecretKeyring {
  activeKeyId: string;
  keys: ReadonlyMap<string, Buffer>;
}

export interface WebhookSigningSecretContext {
  organizationId: string;
  endpointId: string;
  versionNumber: number;
}

export class WebhookSigningSecretInputError extends Error {
  constructor() {
    super(
      `Webhook signing secret must contain ${WEBHOOK_SIGNING_SECRET_LIMITS.minBytes} to ${WEBHOOK_SIGNING_SECRET_LIMITS.maxBytes} UTF-8 bytes.`,
    );
    this.name = 'WebhookSigningSecretInputError';
  }
}

export class StoredWebhookSigningSecretInvariantError extends Error {
  constructor() {
    super('Stored webhook signing-secret envelope is invalid.');
    this.name = 'StoredWebhookSigningSecretInvariantError';
  }
}

export class StoredWebhookSigningSecretResolutionError extends Error {
  constructor(options?: ErrorOptions) {
    super('Stored webhook signing secret could not be resolved.', options);
    this.name = 'StoredWebhookSigningSecretResolutionError';
  }
}

export class StoredWebhookSigningSecretKeyUnavailableError extends StoredWebhookSigningSecretResolutionError {
  constructor() {
    super();
    this.name = 'StoredWebhookSigningSecretKeyUnavailableError';
  }
}

export function loadWebhookSigningSecretKeyring(
  environment: NodeJS.ProcessEnv,
): WebhookSigningSecretKeyring {
  const activeKeyId = environment.WEBHOOK_SIGNING_SECRET_ACTIVE_KEY_ID;
  if (!activeKeyId) throw new Error('WEBHOOK_SIGNING_SECRET_ACTIVE_KEY_ID is required.');
  if (activeKeyId.length > 120)
    throw new Error('WEBHOOK_SIGNING_SECRET_ACTIVE_KEY_ID must not exceed 120 characters.');
  const serialized = environment.WEBHOOK_SIGNING_SECRET_ENCRYPTION_KEYS;
  if (!serialized) throw new Error('WEBHOOK_SIGNING_SECRET_ENCRYPTION_KEYS is required.');
  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch {
    throw new Error('WEBHOOK_SIGNING_SECRET_ENCRYPTION_KEYS must be a JSON object.');
  }
  if (!isRecord(value) || Object.keys(value).length === 0)
    throw new Error('WEBHOOK_SIGNING_SECRET_ENCRYPTION_KEYS must be a non-empty JSON object.');
  const keys = new Map<string, Buffer>();
  for (const [keyId, encoded] of Object.entries(value)) {
    if (!keyId || keyId.length > 120 || typeof encoded !== 'string')
      throw new Error('Every webhook encryption key must have a valid string ID and value.');
    const key = decodeCanonicalBase64(encoded);
    if (!key || key.length !== 32)
      throw new Error(`Webhook encryption key ${keyId} must decode to exactly 32 bytes.`);
    keys.set(keyId, key);
  }
  if (!keys.has(activeKeyId))
    throw new Error(
      'WEBHOOK_SIGNING_SECRET_ACTIVE_KEY_ID does not exist in WEBHOOK_SIGNING_SECRET_ENCRYPTION_KEYS.',
    );
  return { activeKeyId, keys };
}

export function encryptWebhookSigningSecret(
  value: string,
  context: WebhookSigningSecretContext,
  keyring: WebhookSigningSecretKeyring,
): EncryptedWebhookSigningSecretV1 {
  const plaintext = Buffer.from(value, 'utf8');
  if (
    plaintext.length < WEBHOOK_SIGNING_SECRET_LIMITS.minBytes ||
    plaintext.length > WEBHOOK_SIGNING_SECRET_LIMITS.maxBytes
  )
    throw new WebhookSigningSecretInputError();
  assertContext(context);
  const key = keyring.keys.get(keyring.activeKeyId);
  if (!key) throw new Error(`Webhook encryption key ${keyring.activeKeyId} is unavailable.`);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(aad(context));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return {
    version: 1,
    algorithm: 'AES-256-GCM',
    keyId: keyring.activeKeyId,
    iv: iv.toString('base64url'),
    ciphertext: ciphertext.toString('base64url'),
    authTag: cipher.getAuthTag().toString('base64url'),
  };
}

export function decryptWebhookSigningSecret(
  value: unknown,
  context: WebhookSigningSecretContext,
  keyring: WebhookSigningSecretKeyring,
): string {
  const envelope = parseStoredWebhookSigningSecret(value);
  assertContext(context);
  try {
    const key = keyring.keys.get(envelope.keyId);
    if (!key) throw new StoredWebhookSigningSecretKeyUnavailableError();
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64url'));
    decipher.setAAD(aad(context));
    decipher.setAuthTag(Buffer.from(envelope.authTag, 'base64url'));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(envelope.ciphertext, 'base64url')),
      decipher.final(),
    ]);
    if (
      plaintext.length < WEBHOOK_SIGNING_SECRET_LIMITS.minBytes ||
      plaintext.length > WEBHOOK_SIGNING_SECRET_LIMITS.maxBytes
    )
      throw new Error('Decrypted signing secret has an invalid size.');
    return plaintext.toString('utf8');
  } catch (error) {
    if (error instanceof StoredWebhookSigningSecretKeyUnavailableError) throw error;
    throw new StoredWebhookSigningSecretResolutionError({ cause: error });
  }
}

export function signWebhookBody(
  signingSecret: string,
  unixTimestampSeconds: number,
  body: Uint8Array,
): string {
  if (!Number.isSafeInteger(unixTimestampSeconds) || unixTimestampSeconds < 0)
    throw new RangeError('Webhook signature timestamp must be a non-negative safe integer.');
  const hmac = createHmac('sha256', signingSecret);
  hmac.update(`${unixTimestampSeconds}.`, 'utf8');
  hmac.update(body);
  return `v1=${hmac.digest('hex')}`;
}

export function parseStoredWebhookSigningSecret(value: unknown): EncryptedWebhookSigningSecretV1 {
  if (!hasExactKeys(value, ['version', 'algorithm', 'keyId', 'iv', 'ciphertext', 'authTag']))
    throw new StoredWebhookSigningSecretInvariantError();
  const iv = decodeCanonicalBase64Url(value.iv);
  const ciphertext = decodeCanonicalBase64Url(value.ciphertext);
  const authTag = decodeCanonicalBase64Url(value.authTag);
  if (
    value.version !== 1 ||
    value.algorithm !== 'AES-256-GCM' ||
    typeof value.keyId !== 'string' ||
    value.keyId.length < 1 ||
    value.keyId.length > 120 ||
    !iv ||
    iv.length !== 12 ||
    !ciphertext ||
    ciphertext.length < WEBHOOK_SIGNING_SECRET_LIMITS.minBytes ||
    ciphertext.length > WEBHOOK_SIGNING_SECRET_LIMITS.maxBytes ||
    !authTag ||
    authTag.length !== 16
  )
    throw new StoredWebhookSigningSecretInvariantError();
  return value as unknown as EncryptedWebhookSigningSecretV1;
}

function aad(context: WebhookSigningSecretContext): Buffer {
  return Buffer.from(
    [
      'watchrail:webhook-signing-secret:v1',
      context.organizationId,
      context.endpointId,
      String(context.versionNumber),
    ].join('\n'),
    'utf8',
  );
}

function assertContext(context: WebhookSigningSecretContext): void {
  if (
    !UUID_PATTERN.test(context.organizationId) ||
    !UUID_PATTERN.test(context.endpointId) ||
    !Number.isSafeInteger(context.versionNumber) ||
    context.versionNumber < 1
  )
    throw new RangeError('Webhook signing-secret context is invalid.');
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
function decodeCanonicalBase64(value: string): Buffer | null {
  const decoded = Buffer.from(value, 'base64');
  return decoded.toString('base64').replace(/=+$/u, '') === value.replace(/=+$/u, '')
    ? decoded
    : null;
}
function decodeCanonicalBase64Url(value: unknown): Buffer | null {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/u.test(value)) return null;
  const decoded = Buffer.from(value, 'base64url');
  return decoded.toString('base64url') === value ? decoded : null;
}
function hasExactKeys(
  value: unknown,
  expected: readonly string[],
): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const actual = Object.keys(value).sort();
  const sorted = [...expected].sort();
  return actual.length === sorted.length && actual.every((key, index) => key === sorted[index]);
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
