import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { WebhookSigningSecretKeyring } from './webhook-signing-secret.js';

export const SLACK_WEBHOOK_URL_LIMITS = { minBytes: 64, maxBytes: 2048 } as const;

export interface EncryptedSlackWebhookUrlV1 {
  version: 1;
  algorithm: 'AES-256-GCM';
  keyId: string;
  iv: string;
  ciphertext: string;
  authTag: string;
}

export interface SlackWebhookUrlContext {
  organizationId: string;
  channelId: string;
  versionNumber: number;
}

export class SlackWebhookUrlInputError extends Error {
  constructor(message = 'Slack incoming webhook URL is invalid.') {
    super(message);
    this.name = 'SlackWebhookUrlInputError';
  }
}

export class StoredSlackWebhookUrlInvariantError extends Error {
  constructor() {
    super('Stored Slack webhook URL envelope is invalid.');
    this.name = 'StoredSlackWebhookUrlInvariantError';
  }
}

export class StoredSlackWebhookUrlResolutionError extends Error {
  constructor(options?: ErrorOptions) {
    super('Stored Slack webhook URL could not be resolved.', options);
    this.name = 'StoredSlackWebhookUrlResolutionError';
  }
}

export class StoredSlackWebhookUrlKeyUnavailableError extends StoredSlackWebhookUrlResolutionError {
  constructor() {
    super();
    this.name = 'StoredSlackWebhookUrlKeyUnavailableError';
  }
}

export function parseSlackIncomingWebhookUrl(value: string): string {
  const bytes = Buffer.byteLength(value, 'utf8');
  if (bytes < SLACK_WEBHOOK_URL_LIMITS.minBytes || bytes > SLACK_WEBHOOK_URL_LIMITS.maxBytes)
    throw new SlackWebhookUrlInputError();
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new SlackWebhookUrlInputError();
  }
  if (
    url.protocol !== 'https:' ||
    url.hostname !== 'hooks.slack.com' ||
    url.port !== '' ||
    url.username !== '' ||
    url.password !== '' ||
    url.search !== '' ||
    url.hash !== '' ||
    !/^\/services\/[A-Za-z0-9]+\/[A-Za-z0-9]+\/[A-Za-z0-9]+$/u.test(url.pathname)
  )
    throw new SlackWebhookUrlInputError();
  return url.href;
}

export function encryptSlackWebhookUrl(
  value: string,
  context: SlackWebhookUrlContext,
  keyring: WebhookSigningSecretKeyring,
): EncryptedSlackWebhookUrlV1 {
  const normalized = parseSlackIncomingWebhookUrl(value);
  assertContext(context);
  const key = keyring.keys.get(keyring.activeKeyId);
  if (!key) throw new Error(`Webhook encryption key ${keyring.activeKeyId} is unavailable.`);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(aad(context));
  const ciphertext = Buffer.concat([cipher.update(normalized, 'utf8'), cipher.final()]);
  return {
    version: 1,
    algorithm: 'AES-256-GCM',
    keyId: keyring.activeKeyId,
    iv: iv.toString('base64url'),
    ciphertext: ciphertext.toString('base64url'),
    authTag: cipher.getAuthTag().toString('base64url'),
  };
}

export function decryptSlackWebhookUrl(
  value: unknown,
  context: SlackWebhookUrlContext,
  keyring: WebhookSigningSecretKeyring,
): string {
  const envelope = parseStoredSlackWebhookUrl(value);
  assertContext(context);
  try {
    const key = keyring.keys.get(envelope.keyId);
    if (!key) throw new StoredSlackWebhookUrlKeyUnavailableError();
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64url'));
    decipher.setAAD(aad(context));
    decipher.setAuthTag(Buffer.from(envelope.authTag, 'base64url'));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(envelope.ciphertext, 'base64url')),
      decipher.final(),
    ]).toString('utf8');
    return parseSlackIncomingWebhookUrl(plaintext);
  } catch (error) {
    if (error instanceof StoredSlackWebhookUrlKeyUnavailableError) throw error;
    throw new StoredSlackWebhookUrlResolutionError({ cause: error });
  }
}

export function parseStoredSlackWebhookUrl(value: unknown): EncryptedSlackWebhookUrlV1 {
  if (!hasExactKeys(value, ['version', 'algorithm', 'keyId', 'iv', 'ciphertext', 'authTag']))
    throw new StoredSlackWebhookUrlInvariantError();
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
    ciphertext.length < SLACK_WEBHOOK_URL_LIMITS.minBytes ||
    ciphertext.length > SLACK_WEBHOOK_URL_LIMITS.maxBytes ||
    !authTag ||
    authTag.length !== 16
  )
    throw new StoredSlackWebhookUrlInvariantError();
  return value as unknown as EncryptedSlackWebhookUrlV1;
}

function aad(context: SlackWebhookUrlContext): Buffer {
  return Buffer.from(
    [
      'watchrail:slack-webhook-url:v1',
      context.organizationId,
      context.channelId,
      String(context.versionNumber),
    ].join('\n'),
    'utf8',
  );
}

function assertContext(context: SlackWebhookUrlContext): void {
  if (
    !UUID_PATTERN.test(context.organizationId) ||
    !UUID_PATTERN.test(context.channelId) ||
    !Number.isSafeInteger(context.versionNumber) ||
    context.versionNumber < 1
  )
    throw new RangeError('Slack webhook URL context is invalid.');
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function decodeCanonicalBase64Url(value: unknown): Buffer | null {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/u.test(value)) return null;
  const decoded = Buffer.from(value, 'base64url');
  return decoded.toString('base64url') === value ? decoded : null;
}

function hasExactKeys(
  value: unknown,
  expected: readonly string[],
): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const sorted = [...expected].sort();
  return actual.length === sorted.length && actual.every((key, index) => key === sorted[index]);
}
