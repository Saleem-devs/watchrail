import { describe, expect, it } from 'vitest';
import {
  decryptWebhookSigningSecret,
  encryptWebhookSigningSecret,
  loadWebhookSigningSecretKeyring,
  parseStoredWebhookSigningSecret,
  signWebhookBody,
  StoredWebhookSigningSecretInvariantError,
  StoredWebhookSigningSecretResolutionError,
  WebhookSigningSecretInputError,
} from './webhook-signing-secret.js';

const context = {
  organizationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  endpointId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  versionNumber: 1,
};
const oldKey = Buffer.alloc(32, 1);
const activeKey = Buffer.alloc(32, 2);
const keyring = {
  activeKeyId: 'active',
  keys: new Map([
    ['old', oldKey],
    ['active', activeKey],
  ]),
};
const secret = 'watchrail-webhook-secret-value-1234';

describe('webhook signing-secret security', () => {
  it('encrypts with the active key and round-trips in the same endpoint-version context', () => {
    const envelope = encryptWebhookSigningSecret(secret, context, keyring);
    expect(envelope).toMatchObject({
      version: 1,
      algorithm: 'AES-256-GCM',
      keyId: 'active',
    });
    expect(JSON.stringify(envelope)).not.toContain(secret);
    expect(decryptWebhookSigningSecret(envelope, context, keyring)).toBe(secret);
  });

  it('binds authentication to the organization, endpoint, and immutable version', () => {
    const envelope = encryptWebhookSigningSecret(secret, context, keyring);
    for (const changed of [
      { ...context, organizationId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' },
      { ...context, endpointId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' },
      { ...context, versionNumber: 2 },
    ]) {
      expect(() => decryptWebhookSigningSecret(envelope, changed, keyring)).toThrow(
        StoredWebhookSigningSecretResolutionError,
      );
    }
  });

  it('retains decryptability under a retired key while that key remains available', () => {
    const oldKeyring = { activeKeyId: 'old', keys: keyring.keys };
    const envelope = encryptWebhookSigningSecret(secret, context, oldKeyring);
    expect(decryptWebhookSigningSecret(envelope, context, keyring)).toBe(secret);
    expect(() =>
      decryptWebhookSigningSecret(envelope, context, {
        activeKeyId: 'active',
        keys: new Map([['active', activeKey]]),
      }),
    ).toThrow(StoredWebhookSigningSecretResolutionError);
  });

  it('strictly validates stored envelopes and signing-secret byte bounds', () => {
    const envelope = encryptWebhookSigningSecret(secret, context, keyring);
    expect(parseStoredWebhookSigningSecret(envelope)).toEqual(envelope);
    expect(() => parseStoredWebhookSigningSecret({ ...envelope, plaintext: secret })).toThrow(
      StoredWebhookSigningSecretInvariantError,
    );
    expect(() => encryptWebhookSigningSecret('short', context, keyring)).toThrow(
      WebhookSigningSecretInputError,
    );
    expect(() => encryptWebhookSigningSecret('x'.repeat(513), context, keyring)).toThrow(
      WebhookSigningSecretInputError,
    );
  });

  it('loads only canonical 32-byte keys and a declared active key', () => {
    expect(
      loadWebhookSigningSecretKeyring({
        WEBHOOK_SIGNING_SECRET_ACTIVE_KEY_ID: 'active',
        WEBHOOK_SIGNING_SECRET_ENCRYPTION_KEYS: JSON.stringify({
          active: activeKey.toString('base64'),
        }),
      }),
    ).toMatchObject({ activeKeyId: 'active' });
    expect(() =>
      loadWebhookSigningSecretKeyring({
        WEBHOOK_SIGNING_SECRET_ACTIVE_KEY_ID: 'missing',
        WEBHOOK_SIGNING_SECRET_ENCRYPTION_KEYS: JSON.stringify({
          active: activeKey.toString('base64'),
        }),
      }),
    ).toThrow('does not exist');
    expect(() =>
      loadWebhookSigningSecretKeyring({
        WEBHOOK_SIGNING_SECRET_ACTIVE_KEY_ID: 'active',
        WEBHOOK_SIGNING_SECRET_ENCRYPTION_KEYS: JSON.stringify({ active: 'not-base64!' }),
      }),
    ).toThrow('exactly 32 bytes');
  });

  it('signs the exact supplied bytes with a stable timestamped V1 signature', () => {
    const timestamp = 1_800_000_000;
    const body = Buffer.from('{"event":"opened"}', 'utf8');
    const signature = signWebhookBody(secret, timestamp, body);
    expect(signature).toMatch(/^v1=[0-9a-f]{64}$/u);
    expect(signWebhookBody(secret, timestamp, body)).toBe(signature);
    const changed = Buffer.from(body);
    changed[changed.length - 2] = 'X'.charCodeAt(0);
    expect(signWebhookBody(secret, timestamp, changed)).not.toBe(signature);
    expect(signWebhookBody(secret, timestamp + 1, body)).not.toBe(signature);
  });
});
