import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export interface AuthEmailKeyring {
  activeKeyId: string;
  keys: ReadonlyMap<string, Buffer>;
}

export interface EncryptedAuthEmailV1 {
  contractVersion: 1;
  keyId: string;
  iv: string;
  ciphertext: string;
  authTag: string;
}

export function loadAuthEmailKeyring(env: NodeJS.ProcessEnv): AuthEmailKeyring {
  const activeKeyId = env.AUTH_EMAIL_ACTIVE_KEY_ID;
  const encoded = env.AUTH_EMAIL_ENCRYPTION_KEYS;
  if (!activeKeyId || !encoded) throw new Error('Auth email encryption keyring is required.');
  const parsed = JSON.parse(encoded) as Record<string, unknown>;
  const keys = new Map<string, Buffer>();
  for (const [id, value] of Object.entries(parsed)) {
    if (!/^[A-Za-z0-9._-]{1,120}$/u.test(id)) {
      throw new Error('Auth email encryption key IDs must contain 1 to 120 safe characters.');
    }
    if (typeof value !== 'string') throw new Error('Auth email encryption keys must be strings.');
    const key = Buffer.from(value, 'base64');
    if (key.length !== 32) throw new Error(`Auth email encryption key ${id} must be 32 bytes.`);
    keys.set(id, key);
  }
  if (!keys.has(activeKeyId))
    throw new Error('The active auth email encryption key is unavailable.');
  return { activeKeyId, keys };
}

export function encryptAuthEmail(
  payload: unknown,
  messageId: string,
  keyring: AuthEmailKeyring,
): EncryptedAuthEmailV1 {
  const key = keyring.keys.get(keyring.activeKeyId)!;
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(`watchrail:auth-email:v1:${messageId}`, 'utf8'));
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(payload), 'utf8'),
    cipher.final(),
  ]);
  return {
    contractVersion: 1,
    keyId: keyring.activeKeyId,
    iv: iv.toString('base64'),
    ciphertext: ciphertext.toString('base64'),
    authTag: cipher.getAuthTag().toString('base64'),
  };
}

export function decryptAuthEmail(
  value: unknown,
  messageId: string,
  keyring: AuthEmailKeyring,
): unknown {
  const envelope = parseEncryptedAuthEmail(value);
  const key = keyring.keys.get(envelope.keyId);
  if (!key) throw new Error('Auth email encryption key is unavailable.');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64'));
  decipher.setAAD(Buffer.from(`watchrail:auth-email:v1:${messageId}`, 'utf8'));
  decipher.setAuthTag(Buffer.from(envelope.authTag, 'base64'));
  return JSON.parse(
    Buffer.concat([
      decipher.update(Buffer.from(envelope.ciphertext, 'base64')),
      decipher.final(),
    ]).toString('utf8'),
  ) as unknown;
}

export function parseEncryptedAuthEmail(value: unknown): EncryptedAuthEmailV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Stored auth email payload is invalid.');
  }
  const input = value as Record<string, unknown>;
  if (
    Object.keys(input).length !== 5 ||
    input['contractVersion'] !== 1 ||
    typeof input['keyId'] !== 'string' ||
    !/^[A-Za-z0-9._-]{1,120}$/u.test(input['keyId']) ||
    typeof input['iv'] !== 'string' ||
    typeof input['ciphertext'] !== 'string' ||
    typeof input['authTag'] !== 'string'
  ) {
    throw new Error('Stored auth email payload is invalid.');
  }
  const iv = decodeCanonicalBase64(input['iv']);
  const ciphertext = decodeCanonicalBase64(input['ciphertext']);
  const authTag = decodeCanonicalBase64(input['authTag']);
  if (iv.length !== 12 || authTag.length !== 16 || ciphertext.length > 65_536) {
    throw new Error('Stored auth email payload is invalid.');
  }
  return {
    contractVersion: 1,
    keyId: input['keyId'],
    iv: input['iv'],
    ciphertext: input['ciphertext'],
    authTag: input['authTag'],
  };
}

function decodeCanonicalBase64(value: string): Buffer {
  const decoded = Buffer.from(value, 'base64');
  if (decoded.toString('base64') !== value) {
    throw new Error('Stored auth email payload is invalid.');
  }
  return decoded;
}
