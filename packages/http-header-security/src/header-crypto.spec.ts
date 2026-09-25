import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { decryptHeaderValue, encryptHeaderValue, loadHeaderEncryptionKeyring } from './index.js';

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
    ).toThrow();
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
});
