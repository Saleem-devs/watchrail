import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type {
  EncryptedHeaderValueV1,
  RequestHeaderUpdate,
  ResolvedRequestHeader,
  StoredRequestHeader,
} from '@watchrail/domain';

export interface HeaderEncryptionContext {
  organizationId: string;
  monitorId: string;
  normalizedHeaderName: string;
}

export interface HeaderEncryptionKeyring {
  activeKeyId: string;
  keys: ReadonlyMap<string, Buffer>;
}

export function loadHeaderEncryptionKeyring(
  environment: NodeJS.ProcessEnv,
): HeaderEncryptionKeyring {
  const activeKeyId = environment.HTTP_HEADER_ACTIVE_KEY_ID;
  if (!activeKeyId) throw new Error('HTTP_HEADER_ACTIVE_KEY_ID is required.');

  const serializedKeys = environment.HTTP_HEADER_ENCRYPTION_KEYS;
  if (!serializedKeys) throw new Error('HTTP_HEADER_ENCRYPTION_KEYS is required.');

  let values: unknown;
  try {
    values = JSON.parse(serializedKeys);
  } catch {
    throw new Error('HTTP_HEADER_ENCRYPTION_KEYS must be a JSON object.');
  }
  if (!isRecord(values) || Object.keys(values).length === 0) {
    throw new Error('HTTP_HEADER_ENCRYPTION_KEYS must be a non-empty JSON object.');
  }

  const keys = new Map<string, Buffer>();
  for (const [keyId, encoded] of Object.entries(values)) {
    if (!keyId || typeof encoded !== 'string') {
      throw new Error('Every HTTP header encryption key must have a string ID and value.');
    }
    const key = decodeBase64Key(encoded);
    if (key.length !== 32) {
      throw new Error(`HTTP header encryption key ${keyId} must decode to exactly 32 bytes.`);
    }
    keys.set(keyId, key);
  }
  if (!keys.has(activeKeyId)) {
    throw new Error('HTTP_HEADER_ACTIVE_KEY_ID does not exist in HTTP_HEADER_ENCRYPTION_KEYS.');
  }
  return { activeKeyId, keys };
}

export function encryptHeaderValue(
  plaintext: string,
  context: HeaderEncryptionContext,
  keyring: HeaderEncryptionKeyring,
): EncryptedHeaderValueV1 {
  const key = requiredKey(keyring, keyring.activeKeyId);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(aad(context));
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);

  return {
    version: 1,
    algorithm: 'AES-256-GCM',
    keyId: keyring.activeKeyId,
    iv: iv.toString('base64url'),
    ciphertext: ciphertext.toString('base64url'),
    authTag: cipher.getAuthTag().toString('base64url'),
  };
}

export function decryptHeaderValue(
  envelope: EncryptedHeaderValueV1,
  context: HeaderEncryptionContext,
  keyring: HeaderEncryptionKeyring,
): string {
  if (envelope.version !== 1 || envelope.algorithm !== 'AES-256-GCM') {
    throw new Error('Unsupported HTTP header encryption envelope.');
  }
  const decipher = createDecipheriv(
    'aes-256-gcm',
    requiredKey(keyring, envelope.keyId),
    Buffer.from(envelope.iv, 'base64url'),
  );
  decipher.setAAD(aad(context));
  decipher.setAuthTag(Buffer.from(envelope.authTag, 'base64url'));
  return Buffer.concat([
    decipher.update(Buffer.from(envelope.ciphertext, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
}

export function storeRequestHeaders(
  updates: readonly RequestHeaderUpdate[],
  existing: readonly StoredRequestHeader[],
  context: Omit<HeaderEncryptionContext, 'normalizedHeaderName'>,
  keyring: HeaderEncryptionKeyring,
): StoredRequestHeader[] {
  const existingByName = new Map(existing.map((header) => [header.name, header]));

  return updates.map((update) => {
    if (!update.sensitive) return update;

    if ('retain' in update) {
      const previous = existingByName.get(update.name);
      if (!previous?.sensitive) {
        throw new Error(`Cannot retain missing sensitive header ${update.name}.`);
      }
      return previous;
    }

    return {
      name: update.name,
      sensitive: true,
      encryptedValue: encryptHeaderValue(
        update.value,
        { ...context, normalizedHeaderName: update.name },
        keyring,
      ),
    };
  });
}

export function resolveRequestHeaders(
  headers: readonly StoredRequestHeader[],
  context: Omit<HeaderEncryptionContext, 'normalizedHeaderName'>,
  keyring: HeaderEncryptionKeyring,
): ResolvedRequestHeader[] {
  return headers.map((header) => ({
    name: header.name,
    value: header.sensitive
      ? decryptHeaderValue(
          header.encryptedValue,
          { ...context, normalizedHeaderName: header.name },
          keyring,
        )
      : header.value,
  }));
}

function aad(context: HeaderEncryptionContext): Buffer {
  return Buffer.from(
    [
      'watchrail:http-header:v1',
      context.organizationId,
      context.monitorId,
      context.normalizedHeaderName,
    ].join('\n'),
    'utf8',
  );
}

function requiredKey(keyring: HeaderEncryptionKeyring, keyId: string): Buffer {
  const key = keyring.keys.get(keyId);
  if (!key) throw new Error(`HTTP header encryption key ${keyId} is unavailable.`);
  return key;
}

function decodeBase64Key(value: string): Buffer {
  const key = Buffer.from(value, 'base64');
  if (key.toString('base64').replace(/=+$/u, '') !== value.replace(/=+$/u, ''))
    return Buffer.alloc(0);
  return key;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
