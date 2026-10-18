import { describe, expect, it } from 'vitest';
import {
  decryptAuthEmail,
  encryptAuthEmail,
  loadAuthEmailKeyring,
  type AuthEmailKeyring,
} from './auth-email-security.js';

const messageId = '72dc5a63-9ab0-4bf7-898d-778b2bb22af7';
const keyring: AuthEmailKeyring = {
  activeKeyId: 'primary',
  keys: new Map([['primary', Buffer.alloc(32, 7)]]),
};

describe('auth email encryption', () => {
  it('round-trips a payload without storing its plaintext', () => {
    const payload = { type: 'OTP', to: 'person@example.test', otp: '123456' };
    const envelope = encryptAuthEmail(payload, messageId, keyring);

    expect(JSON.stringify(envelope)).not.toContain('person@example.test');
    expect(JSON.stringify(envelope)).not.toContain('123456');
    expect(decryptAuthEmail(envelope, messageId, keyring)).toEqual(payload);
  });

  it('binds ciphertext to its outbox message identity', () => {
    const envelope = encryptAuthEmail({ otp: '123456' }, messageId, keyring);

    expect(() =>
      decryptAuthEmail(envelope, '7d684498-7975-4d9a-b9a3-fe81fd182f41', keyring),
    ).toThrow();
  });

  it('rejects modified ciphertext', () => {
    const envelope = encryptAuthEmail({ otp: '123456' }, messageId, keyring);
    const ciphertext = Buffer.from(envelope.ciphertext, 'base64');
    ciphertext[0] = (ciphertext[0] ?? 0) ^ 1;

    expect(() =>
      decryptAuthEmail(
        { ...envelope, ciphertext: ciphertext.toString('base64') },
        messageId,
        keyring,
      ),
    ).toThrow();
  });

  it('validates the configured active key and key length', () => {
    const valid = loadAuthEmailKeyring({
      AUTH_EMAIL_ACTIVE_KEY_ID: 'primary',
      AUTH_EMAIL_ENCRYPTION_KEYS: JSON.stringify({
        primary: Buffer.alloc(32, 3).toString('base64'),
      }),
    });
    expect(valid.activeKeyId).toBe('primary');

    expect(() =>
      loadAuthEmailKeyring({
        AUTH_EMAIL_ACTIVE_KEY_ID: 'missing',
        AUTH_EMAIL_ENCRYPTION_KEYS: JSON.stringify({
          primary: Buffer.alloc(32).toString('base64'),
        }),
      }),
    ).toThrow('active auth email encryption key is unavailable');
    expect(() =>
      loadAuthEmailKeyring({
        AUTH_EMAIL_ACTIVE_KEY_ID: 'primary',
        AUTH_EMAIL_ENCRYPTION_KEYS: JSON.stringify({
          primary: Buffer.alloc(31).toString('base64'),
        }),
      }),
    ).toThrow('must be 32 bytes');
  });
});
