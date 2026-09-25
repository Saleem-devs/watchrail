import { describe, expect, it } from 'vitest';
import {
  assertNoRetainedHeaders,
  normalizeRequestHeaderUpdates,
  parseStoredRequestHeaders,
  RequestHeaderInputError,
  StoredRequestHeadersInvariantError,
} from './request-header.js';

describe('request header policy', () => {
  it('normalizes names and forces known credentials to be sensitive', () => {
    expect(
      normalizeRequestHeaderUpdates([
        { name: ' X-Environment ', sensitive: false, value: 'production' },
        { name: 'Authorization', sensitive: false, value: 'Bearer secret' },
      ]),
    ).toEqual([
      { name: 'x-environment', sensitive: false, value: 'production' },
      { name: 'authorization', sensitive: true, value: 'Bearer secret' },
    ]);
  });

  it.each(['Host', 'Content-Length', 'Connection', 'Proxy-Authorization', 'Expect'])(
    'rejects transport-controlled header %s',
    (name) => {
      expect(() =>
        normalizeRequestHeaderUpdates([{ name, sensitive: false, value: 'value' }]),
      ).toThrow(RequestHeaderInputError);
    },
  );

  it('rejects case-insensitive duplicates and control characters', () => {
    expect(() =>
      normalizeRequestHeaderUpdates([
        { name: 'X-Key', sensitive: false, value: 'one' },
        { name: 'x-key', sensitive: false, value: 'two' },
      ]),
    ).toThrow('Request headers are invalid.');
    expect(() =>
      normalizeRequestHeaderUpdates([{ name: 'x-key', sensitive: false, value: 'bad\r\nvalue' }]),
    ).toThrow('Request headers are invalid.');
  });

  it('allows explicit retention only outside monitor creation', () => {
    const headers = normalizeRequestHeaderUpdates([
      { name: 'authorization', sensitive: true, retain: true },
    ]);
    expect(headers).toEqual([{ name: 'authorization', sensitive: true, retain: true }]);
    expect(() => assertNoRetainedHeaders(headers)).toThrow(RequestHeaderInputError);
  });

  it('parses the complete stored plaintext and encrypted header contract', () => {
    const stored = [
      { name: 'x-environment', sensitive: false, value: 'production' },
      {
        name: 'authorization',
        sensitive: true,
        encryptedValue: {
          version: 1,
          algorithm: 'AES-256-GCM',
          keyId: 'v1',
          iv: 'AAAAAAAAAAAAAAAA',
          ciphertext: 'c2VjcmV0',
          authTag: 'AAAAAAAAAAAAAAAAAAAAAA',
        },
      },
    ];

    expect(parseStoredRequestHeaders(stored)).toEqual(stored);
  });

  it.each([
    null,
    {},
    [{ name: 'Authorization', sensitive: false, value: 'secret' }],
    [{ name: 'host', sensitive: false, value: 'example.com' }],
    [{ name: 'x-key', sensitive: false, value: 'bad\r\nvalue' }],
    [{ name: 'authorization', sensitive: true, encryptedValue: {} }],
    [
      {
        name: 'authorization',
        sensitive: true,
        encryptedValue: {
          version: 1,
          algorithm: 'AES-256-GCM',
          keyId: 'v1',
          iv: 'too-short',
          ciphertext: 'c2VjcmV0',
          authTag: 'AAAAAAAAAAAAAAAAAAAAAA',
        },
      },
    ],
  ])('rejects corrupted stored headers %#', (stored) => {
    expect(() => parseStoredRequestHeaders(stored)).toThrow(StoredRequestHeadersInvariantError);
  });
});
