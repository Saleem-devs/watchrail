import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import {
  ASSERTION_LIMITS,
  AssertionInputError,
  parseResponseAssertions,
  parseStoredAssertionConfiguration,
  type EncryptedAssertionValueV1,
  type HttpMonitorMethod,
  type JsonScalarTarget,
  type ResponseAssertionConfigurationV1,
  type ResponseAssertions,
  type StoredJsonAssertionTarget,
  type StoredResponseAssertionsV1,
  type StoredStringAssertionTarget,
} from '@watchrail/domain';

export interface AssertionEncryptionKeyring {
  activeKeyId: string;
  keys: ReadonlyMap<string, Buffer>;
}

export interface AssertionEncryptionContext {
  organizationId: string;
  monitorId: string;
}

export class StoredAssertionResolutionError extends Error {
  constructor(options?: ErrorOptions) {
    super('Stored assertion secrets could not be resolved.', options);
    this.name = 'StoredAssertionResolutionError';
  }
}

export class AssertionRetentionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AssertionRetentionError';
  }
}

class UnavailableAssertionKeyError extends Error {}

type Source = 'HEADER' | 'TEXT_BODY' | 'JSON_BODY';

export function loadAssertionEncryptionKeyring(
  environment: NodeJS.ProcessEnv,
): AssertionEncryptionKeyring {
  const activeKeyId = environment.ASSERTION_ACTIVE_KEY_ID;
  if (!activeKeyId) throw new Error('ASSERTION_ACTIVE_KEY_ID is required.');
  const serialized = environment.ASSERTION_ENCRYPTION_KEYS;
  if (!serialized) throw new Error('ASSERTION_ENCRYPTION_KEYS is required.');
  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch {
    throw new Error('ASSERTION_ENCRYPTION_KEYS must be a JSON object.');
  }
  if (!isRecord(value) || Object.keys(value).length === 0) {
    throw new Error('ASSERTION_ENCRYPTION_KEYS must be a non-empty JSON object.');
  }
  const keys = new Map<string, Buffer>();
  for (const [keyId, encoded] of Object.entries(value)) {
    if (!keyId || keyId.length > 120 || typeof encoded !== 'string') {
      throw new Error('Every assertion encryption key must have a string ID and value.');
    }
    const key = decodeBase64Key(encoded);
    if (key.length !== 32) {
      throw new Error(`Assertion encryption key ${keyId} must decode to exactly 32 bytes.`);
    }
    keys.set(keyId, key);
  }
  if (!keys.has(activeKeyId)) {
    throw new Error('ASSERTION_ACTIVE_KEY_ID does not exist in ASSERTION_ENCRYPTION_KEYS.');
  }
  return { activeKeyId, keys };
}

export function storeResponseAssertions(
  input: unknown,
  existingValue: unknown,
  method: HttpMonitorMethod,
  context: AssertionEncryptionContext,
  keyring: AssertionEncryptionKeyring,
  options: { allowRetain: boolean },
): ResponseAssertionConfigurationV1 {
  const existing = parseStoredAssertionConfiguration(existingValue);
  const retained = findRetainedTargets(input);
  if (!options.allowRetain && retained.length > 0) {
    throw new AssertionRetentionError('Cannot retain assertion secrets during monitor creation.');
  }
  const normalized = parseResponseAssertions(replaceRetainedTargets(input), method);
  const stored = storeNormalized(normalized, existing.assertions, retained, context, keyring);
  return parseStoredAssertionConfiguration({ contractVersion: 1, assertions: stored });
}

export function resolveResponseAssertions(
  value: unknown,
  method: HttpMonitorMethod,
  context: AssertionEncryptionContext,
  keyring: AssertionEncryptionKeyring,
): ResponseAssertions {
  const stored = parseStoredAssertionConfiguration(value).assertions;
  const input = {
    headers: stored.headers.map((assertion, index) =>
      'target' in assertion
        ? {
            ...assertion,
            target: resolveStringTarget(
              assertion.target,
              contextFor(context, 'HEADER', index, assertion.name, assertion.operator),
              keyring,
            ),
          }
        : assertion,
    ),
    textBody: stored.textBody.map((assertion, index) => ({
      ...assertion,
      target: resolveStringTarget(
        assertion.target,
        contextFor(context, 'TEXT_BODY', index, null, assertion.operator),
        keyring,
      ),
    })),
    jsonBody: stored.jsonBody.map((assertion, index) =>
      'target' in assertion
        ? {
            ...assertion,
            target: resolveJsonTarget(
              assertion.target,
              contextFor(context, 'JSON_BODY', index, assertion.selector, assertion.operator),
              keyring,
            ),
          }
        : assertion,
    ),
  };
  try {
    return parseResponseAssertions(input, method);
  } catch (error) {
    if (error instanceof AssertionInputError)
      throw new StoredAssertionResolutionError({ cause: error });
    throw error;
  }
}

function storeNormalized(
  assertions: ResponseAssertions,
  existing: StoredResponseAssertionsV1,
  retained: readonly RetainedTarget[],
  context: AssertionEncryptionContext,
  keyring: AssertionEncryptionKeyring,
): StoredResponseAssertionsV1 {
  const retainedKeys = new Set(retained.map((item) => `${item.source}:${item.index}`));
  return {
    headers: assertions.headers.map((assertion, index) => {
      if (!('target' in assertion)) return assertion;
      const encryptionContext = contextFor(
        context,
        'HEADER',
        index,
        assertion.name,
        assertion.operator,
      );
      return {
        ...assertion,
        target: retainedKeys.has(`HEADER:${index}`)
          ? retainString(existing.headers[index], assertion, 'HEADER', index)
          : storeStringTarget(assertion.target, encryptionContext, keyring),
      };
    }),
    textBody: assertions.textBody.map((assertion, index) => ({
      ...assertion,
      target: retainedKeys.has(`TEXT_BODY:${index}`)
        ? retainString(existing.textBody[index], assertion, 'TEXT_BODY', index)
        : storeStringTarget(
            assertion.target,
            contextFor(context, 'TEXT_BODY', index, null, assertion.operator),
            keyring,
          ),
    })),
    jsonBody: assertions.jsonBody.map((assertion, index) => {
      if (!('target' in assertion)) return assertion;
      return {
        ...assertion,
        target: retainedKeys.has(`JSON_BODY:${index}`)
          ? retainJson(existing.jsonBody[index], assertion, index)
          : storeJsonTarget(
              assertion.target,
              contextFor(context, 'JSON_BODY', index, assertion.selector, assertion.operator),
              keyring,
            ),
      };
    }),
  };
}

function retainString(
  existing: unknown,
  next: { operator: string; name?: string },
  source: Source,
  index: number,
): StoredStringAssertionTarget {
  if (
    !isRecord(existing) ||
    !('target' in existing) ||
    !isRecord(existing.target) ||
    existing.target.sensitive !== true
  ) {
    throw new AssertionRetentionError(
      `Cannot retain missing sensitive ${source.toLowerCase()} assertion ${index + 1}.`,
    );
  }
  const subjectMatches = source === 'HEADER' ? existing.name === next.name : true;
  if (!subjectMatches || existing.operator !== next.operator) {
    throw new AssertionRetentionError(
      `Cannot retain changed sensitive ${source.toLowerCase()} assertion ${index + 1}.`,
    );
  }
  return existing.target as unknown as StoredStringAssertionTarget;
}

function retainJson(
  existing: unknown,
  next: { selector: string; operator: string },
  index: number,
): StoredJsonAssertionTarget {
  if (
    !isRecord(existing) ||
    existing.selector !== next.selector ||
    existing.operator !== next.operator ||
    !('target' in existing) ||
    !isRecord(existing.target) ||
    existing.target.sensitive !== true
  ) {
    throw new AssertionRetentionError(
      `Cannot retain changed or missing sensitive JSON assertion ${index + 1}.`,
    );
  }
  return existing.target as unknown as StoredJsonAssertionTarget;
}

function storeStringTarget(
  target: { value: string; sensitive: boolean },
  context: FullContext,
  keyring: AssertionEncryptionKeyring,
): StoredStringAssertionTarget {
  return target.sensitive
    ? { sensitive: true, encryptedValue: encrypt(encodeString(target.value), context, keyring) }
    : { sensitive: false, value: target.value };
}

function storeJsonTarget(
  target: { value: JsonScalarTarget; sensitive: boolean },
  context: FullContext,
  keyring: AssertionEncryptionKeyring,
): StoredJsonAssertionTarget {
  return target.sensitive
    ? { sensitive: true, encryptedValue: encrypt(encodeJsonScalar(target.value), context, keyring) }
    : { sensitive: false, value: target.value };
}

function resolveStringTarget(
  target: StoredStringAssertionTarget,
  context: FullContext,
  keyring: AssertionEncryptionKeyring,
) {
  return target.sensitive
    ? { sensitive: true, value: decodeString(decrypt(target.encryptedValue, context, keyring)) }
    : target;
}

function resolveJsonTarget(
  target: StoredJsonAssertionTarget,
  context: FullContext,
  keyring: AssertionEncryptionKeyring,
) {
  if (!target.sensitive) return target;
  return {
    sensitive: true,
    value: decodeJsonScalar(decrypt(target.encryptedValue, context, keyring)),
  };
}

interface FullContext extends AssertionEncryptionContext {
  source: Source;
  index: number;
  subject: string | null;
  operator: string;
}

function contextFor(
  context: AssertionEncryptionContext,
  source: Source,
  index: number,
  subject: string | null,
  operator: string,
): FullContext {
  return { ...context, source, index, subject, operator };
}

function encrypt(
  bytes: Buffer,
  context: FullContext,
  keyring: AssertionEncryptionKeyring,
): EncryptedAssertionValueV1 {
  if (bytes.length > ASSERTION_LIMITS.maxEncryptedValueBytes)
    throw new AssertionInputError(['Sensitive assertion target is too large.']);
  const key = keyring.keys.get(keyring.activeKeyId);
  if (!key) throw new Error(`Assertion encryption key ${keyring.activeKeyId} is unavailable.`);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(aad(context));
  const ciphertext = Buffer.concat([cipher.update(bytes), cipher.final()]);
  return {
    version: 1,
    algorithm: 'AES-256-GCM',
    keyId: keyring.activeKeyId,
    iv: iv.toString('base64url'),
    ciphertext: ciphertext.toString('base64url'),
    authTag: cipher.getAuthTag().toString('base64url'),
  };
}

function decrypt(
  envelope: EncryptedAssertionValueV1,
  context: FullContext,
  keyring: AssertionEncryptionKeyring,
): Buffer {
  try {
    const key = keyring.keys.get(envelope.keyId);
    if (!key) throw new UnavailableAssertionKeyError();
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64url'));
    decipher.setAAD(aad(context));
    decipher.setAuthTag(Buffer.from(envelope.authTag, 'base64url'));
    return Buffer.concat([
      decipher.update(Buffer.from(envelope.ciphertext, 'base64url')),
      decipher.final(),
    ]);
  } catch (error) {
    if (error instanceof UnavailableAssertionKeyError || error instanceof Error)
      throw new StoredAssertionResolutionError({ cause: error });
    throw error;
  }
}

const STRING_TAG = 0x01;
const JSON_STRING_TAG = 0x11;
const JSON_NUMBER_TAG = 0x12;
const JSON_FALSE_TAG = 0x13;
const JSON_TRUE_TAG = 0x14;
const JSON_NULL_TAG = 0x15;

function encodeString(value: string): Buffer {
  return Buffer.concat([Buffer.from([STRING_TAG]), Buffer.from(value, 'utf16le')]);
}

function decodeString(value: Buffer): string {
  if (value[0] !== STRING_TAG || value.length % 2 !== 1) {
    throw new StoredAssertionResolutionError();
  }
  return value.subarray(1).toString('utf16le');
}

function encodeJsonScalar(value: JsonScalarTarget): Buffer {
  switch (value.type) {
    case 'string':
      return Buffer.concat([Buffer.from([JSON_STRING_TAG]), Buffer.from(value.value, 'utf16le')]);
    case 'number':
      return Buffer.concat([Buffer.from([JSON_NUMBER_TAG]), Buffer.from(value.value, 'ascii')]);
    case 'boolean':
      return Buffer.from([value.value ? JSON_TRUE_TAG : JSON_FALSE_TAG]);
    case 'null':
      return Buffer.from([JSON_NULL_TAG]);
  }
}

function decodeJsonScalar(value: Buffer): unknown {
  const tag = value[0];
  const payload = value.subarray(1);
  if (tag === JSON_STRING_TAG && value.length % 2 === 1) {
    return { type: 'string', value: payload.toString('utf16le') };
  }
  if (tag === JSON_NUMBER_TAG && payload.length > 0) {
    return { type: 'number', value: payload.toString('ascii') };
  }
  if (tag === JSON_FALSE_TAG && payload.length === 0) return { type: 'boolean', value: false };
  if (tag === JSON_TRUE_TAG && payload.length === 0) return { type: 'boolean', value: true };
  if (tag === JSON_NULL_TAG && payload.length === 0) return { type: 'null' };
  throw new StoredAssertionResolutionError();
}

function aad(context: FullContext): Buffer {
  return Buffer.from(
    [
      'watchrail:response-assertion:v1',
      context.organizationId,
      context.monitorId,
      context.source,
      String(context.index),
      context.subject ?? '',
      context.operator,
    ].join('\n'),
    'utf8',
  );
}

interface RetainedTarget {
  source: Source;
  index: number;
}

function findRetainedTargets(value: unknown): RetainedTarget[] {
  if (!isRecord(value)) return [];
  const result: RetainedTarget[] = [];
  for (const [field, source] of [
    ['headers', 'HEADER'],
    ['textBody', 'TEXT_BODY'],
    ['jsonBody', 'JSON_BODY'],
  ] as const) {
    const assertions = value[field];
    if (!Array.isArray(assertions)) continue;
    assertions.forEach((assertion, index) => {
      if (
        isRecord(assertion) &&
        isRecord(assertion.target) &&
        assertion.target.sensitive === true &&
        assertion.target.retain === true
      )
        result.push({ source, index });
    });
  }
  return result;
}

function replaceRetainedTargets(value: unknown): unknown {
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value).map(([field, assertions]) => [
      field,
      Array.isArray(assertions)
        ? assertions.map((assertion: unknown) => {
            if (
              !isRecord(assertion) ||
              !isRecord(assertion.target) ||
              assertion.target.sensitive !== true ||
              assertion.target.retain !== true
            )
              return assertion;
            const target =
              field === 'jsonBody'
                ? { sensitive: true, value: { type: 'null' } }
                : { sensitive: true, value: '' };
            return { ...assertion, target };
          })
        : assertions,
    ]),
  );
}

function decodeBase64Key(value: string): Buffer {
  const key = Buffer.from(value, 'base64');
  return key.toString('base64').replace(/=+$/u, '') === value.replace(/=+$/u, '')
    ? key
    : Buffer.alloc(0);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
