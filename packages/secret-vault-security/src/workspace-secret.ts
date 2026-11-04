import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export const WORKSPACE_SECRET_LIMITS = {
  minBytes: 1,
  maxBytes: 8_192,
  maxKeyIdLength: 120,
} as const;

export interface EncryptedWorkspaceSecretV1 {
  version: 1;
  algorithm: 'AES-256-GCM';
  keyId: string;
  iv: string;
  ciphertext: string;
  authTag: string;
}

export interface WorkspaceSecretKeyring {
  activeKeyId: string;
  keys: ReadonlyMap<string, Buffer>;
}

export interface WorkspaceSecretContext {
  organizationId: string;
  secretId: string;
  versionNumber: number;
}

export class WorkspaceSecretInputError extends Error {
  constructor() {
    super(
      `Secret values must contain ${WORKSPACE_SECRET_LIMITS.minBytes} to ${WORKSPACE_SECRET_LIMITS.maxBytes} UTF-8 bytes.`,
    );
    this.name = 'WorkspaceSecretInputError';
  }
}

export class StoredWorkspaceSecretInvariantError extends Error {
  constructor() {
    super('Stored workspace-secret envelope is invalid.');
    this.name = 'StoredWorkspaceSecretInvariantError';
  }
}

export class StoredWorkspaceSecretResolutionError extends Error {
  constructor(options?: ErrorOptions) {
    super('Stored workspace secret could not be resolved.', options);
    this.name = 'StoredWorkspaceSecretResolutionError';
  }
}

export class StoredWorkspaceSecretKeyUnavailableError extends StoredWorkspaceSecretResolutionError {
  constructor() {
    super();
    this.name = 'StoredWorkspaceSecretKeyUnavailableError';
  }
}

export function loadWorkspaceSecretKeyring(environment: NodeJS.ProcessEnv): WorkspaceSecretKeyring {
  const activeKeyId = environment.WORKSPACE_SECRET_ACTIVE_KEY_ID;
  if (!activeKeyId) throw new Error('WORKSPACE_SECRET_ACTIVE_KEY_ID is required.');
  if (activeKeyId.length > WORKSPACE_SECRET_LIMITS.maxKeyIdLength) {
    throw new Error(
      `WORKSPACE_SECRET_ACTIVE_KEY_ID must not exceed ${WORKSPACE_SECRET_LIMITS.maxKeyIdLength} characters.`,
    );
  }

  const serialized = environment.WORKSPACE_SECRET_ENCRYPTION_KEYS;
  if (!serialized) throw new Error('WORKSPACE_SECRET_ENCRYPTION_KEYS is required.');

  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch {
    throw new Error('WORKSPACE_SECRET_ENCRYPTION_KEYS must be a JSON object.');
  }
  if (!isRecord(value) || Object.keys(value).length === 0) {
    throw new Error('WORKSPACE_SECRET_ENCRYPTION_KEYS must be a non-empty JSON object.');
  }

  const keys = new Map<string, Buffer>();
  for (const [keyId, encoded] of Object.entries(value)) {
    if (
      !keyId ||
      keyId.length > WORKSPACE_SECRET_LIMITS.maxKeyIdLength ||
      typeof encoded !== 'string'
    ) {
      throw new Error('Every workspace-secret encryption key must have a valid ID and value.');
    }
    const key = decodeCanonicalBase64(encoded);
    if (!key || key.length !== 32) {
      throw new Error(`Workspace-secret encryption key ${keyId} must decode to exactly 32 bytes.`);
    }
    keys.set(keyId, key);
  }
  if (!keys.has(activeKeyId)) {
    throw new Error(
      'WORKSPACE_SECRET_ACTIVE_KEY_ID does not exist in WORKSPACE_SECRET_ENCRYPTION_KEYS.',
    );
  }
  return { activeKeyId, keys };
}

export function encryptWorkspaceSecret(
  value: string,
  context: WorkspaceSecretContext,
  keyring: WorkspaceSecretKeyring,
): EncryptedWorkspaceSecretV1 {
  const plaintext = Buffer.from(value, 'utf8');
  assertPlaintextSize(plaintext);
  assertContext(context);

  const key = keyring.keys.get(keyring.activeKeyId);
  if (!key)
    throw new Error(`Workspace-secret encryption key ${keyring.activeKeyId} is unavailable.`);
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

export function decryptWorkspaceSecret(
  value: unknown,
  context: WorkspaceSecretContext,
  keyring: WorkspaceSecretKeyring,
): string {
  const envelope = parseStoredWorkspaceSecret(value);
  assertContext(context);
  try {
    const key = keyring.keys.get(envelope.keyId);
    if (!key) throw new StoredWorkspaceSecretKeyUnavailableError();
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64url'));
    decipher.setAAD(aad(context));
    decipher.setAuthTag(Buffer.from(envelope.authTag, 'base64url'));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(envelope.ciphertext, 'base64url')),
      decipher.final(),
    ]);
    assertPlaintextSize(plaintext);
    return plaintext.toString('utf8');
  } catch (error) {
    if (error instanceof StoredWorkspaceSecretKeyUnavailableError) throw error;
    throw new StoredWorkspaceSecretResolutionError({ cause: error });
  }
}

export function parseStoredWorkspaceSecret(value: unknown): EncryptedWorkspaceSecretV1 {
  if (!hasExactKeys(value, ['version', 'algorithm', 'keyId', 'iv', 'ciphertext', 'authTag'])) {
    throw new StoredWorkspaceSecretInvariantError();
  }
  const iv = decodeCanonicalBase64Url(value.iv);
  const ciphertext = decodeCanonicalBase64Url(value.ciphertext);
  const authTag = decodeCanonicalBase64Url(value.authTag);
  if (
    value.version !== 1 ||
    value.algorithm !== 'AES-256-GCM' ||
    typeof value.keyId !== 'string' ||
    value.keyId.length < 1 ||
    value.keyId.length > WORKSPACE_SECRET_LIMITS.maxKeyIdLength ||
    !iv ||
    iv.length !== 12 ||
    !ciphertext ||
    ciphertext.length < WORKSPACE_SECRET_LIMITS.minBytes ||
    ciphertext.length > WORKSPACE_SECRET_LIMITS.maxBytes ||
    !authTag ||
    authTag.length !== 16
  ) {
    throw new StoredWorkspaceSecretInvariantError();
  }
  return value as unknown as EncryptedWorkspaceSecretV1;
}

function assertPlaintextSize(value: Buffer): void {
  if (
    value.length < WORKSPACE_SECRET_LIMITS.minBytes ||
    value.length > WORKSPACE_SECRET_LIMITS.maxBytes
  ) {
    throw new WorkspaceSecretInputError();
  }
}

function aad(context: WorkspaceSecretContext): Buffer {
  return Buffer.from(
    [
      'watchrail:workspace-secret:v1',
      context.organizationId,
      context.secretId,
      String(context.versionNumber),
    ].join('\n'),
    'utf8',
  );
}

function assertContext(context: WorkspaceSecretContext): void {
  if (
    !UUID_PATTERN.test(context.organizationId) ||
    !UUID_PATTERN.test(context.secretId) ||
    !Number.isSafeInteger(context.versionNumber) ||
    context.versionNumber < 1
  ) {
    throw new RangeError('Workspace-secret context is invalid.');
  }
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
