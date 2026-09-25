import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  decryptHeaderValue,
  encryptHeaderValue,
  loadHeaderEncryptionKeyring,
  resolveRequestHeaders,
  StoredRequestHeaderResolutionError,
  storeRequestHeaders,
} from './index.js';

const key = randomBytes(32).toString('base64');
const context = {
  organizationId: '11111111-1111-4111-8111-111111111111',
  monitorId: '22222222-2222-4222-8222-222222222222',
  normalizedHeaderName: 'authorization',
};

describe('HTTP header encryption', () => {
  it('round trips a value through a versioned AES-256-GCM envelope', () => {
    const keyring = loadHeaderEncryptionKeyring({
      HTTP_HEADER_ACTIVE_KEY_ID: 'v1',
      HTTP_HEADER_ENCRYPTION_KEYS: JSON.stringify({ v1: key }),
    });
    const first = encryptHeaderValue('Bearer secret', context, keyring);
    const second = encryptHeaderValue('Bearer secret', context, keyring);

    expect(first).toMatchObject({ version: 1, algorithm: 'AES-256-GCM', keyId: 'v1' });
    expect(first.iv).not.toBe(second.iv);
    expect(decryptHeaderValue(first, context, keyring)).toBe('Bearer secret');
  });

  it('authenticates organization, monitor, and normalized header name', () => {
    const keyring = loadHeaderEncryptionKeyring({
      HTTP_HEADER_ACTIVE_KEY_ID: 'v1',
      HTTP_HEADER_ENCRYPTION_KEYS: JSON.stringify({ v1: key }),
    });
    const encrypted = encryptHeaderValue('secret', context, keyring);
    expect(() =>
      decryptHeaderValue(encrypted, { ...context, monitorId: 'different' }, keyring),
    ).toThrow(StoredRequestHeaderResolutionError);
  });

  it('translates unavailable envelope keys into a safe resolution error', () => {
    const oldKeyring = loadHeaderEncryptionKeyring({
      HTTP_HEADER_ACTIVE_KEY_ID: 'v0',
      HTTP_HEADER_ENCRYPTION_KEYS: JSON.stringify({ v0: key }),
    });
    const encrypted = encryptHeaderValue('secret', context, oldKeyring);
    const currentOnly = loadHeaderEncryptionKeyring({
      HTTP_HEADER_ACTIVE_KEY_ID: 'v1',
      HTTP_HEADER_ENCRYPTION_KEYS: JSON.stringify({
        v1: randomBytes(32).toString('base64'),
      }),
    });

    expect(() => decryptHeaderValue(encrypted, context, currentOnly)).toThrow(
      StoredRequestHeaderResolutionError,
    );
  });

  it('decrypts old envelopes while encrypting with the active key', () => {
    const oldKeyring = loadHeaderEncryptionKeyring({
      HTTP_HEADER_ACTIVE_KEY_ID: 'v0',
      HTTP_HEADER_ENCRYPTION_KEYS: JSON.stringify({ v0: key }),
    });
    const oldEnvelope = encryptHeaderValue('secret', context, oldKeyring);
    const rotated = loadHeaderEncryptionKeyring({
      HTTP_HEADER_ACTIVE_KEY_ID: 'v1',
      HTTP_HEADER_ENCRYPTION_KEYS: JSON.stringify({
        v0: key,
        v1: randomBytes(32).toString('base64'),
      }),
    });
    expect(decryptHeaderValue(oldEnvelope, context, rotated)).toBe('secret');
    expect(encryptHeaderValue('new', context, rotated).keyId).toBe('v1');
  });

  it('fails fast for invalid key configuration', () => {
    expect(() => loadHeaderEncryptionKeyring({})).toThrow('HTTP_HEADER_ACTIVE_KEY_ID');
    expect(() =>
      loadHeaderEncryptionKeyring({
        HTTP_HEADER_ACTIVE_KEY_ID: 'v1',
        HTTP_HEADER_ENCRYPTION_KEYS: JSON.stringify({ v1: 'short' }),
      }),
    ).toThrow('exactly 32 bytes');
  });

  it('stores secrets encrypted, retains ciphertext explicitly, and resolves only at execution', () => {
    const keyring = loadHeaderEncryptionKeyring({
      HTTP_HEADER_ACTIVE_KEY_ID: 'v1',
      HTTP_HEADER_ENCRYPTION_KEYS: JSON.stringify({ v1: key }),
    });
    const stored = storeRequestHeaders(
      [
        { name: 'authorization', sensitive: true, value: 'Bearer secret' },
        { name: 'x-environment', sensitive: false, value: 'production' },
      ],
      [],
      context,
      keyring,
    );

    expect(stored[0]).not.toHaveProperty('value');
    expect(
      storeRequestHeaders(
        [{ name: 'authorization', sensitive: true, retain: true }],
        stored,
        context,
        keyring,
      )[0],
    ).toEqual(stored[0]);
    expect(resolveRequestHeaders(stored, context, keyring)).toEqual([
      { name: 'authorization', value: 'Bearer secret' },
      { name: 'x-environment', value: 'production' },
    ]);
  });
});
