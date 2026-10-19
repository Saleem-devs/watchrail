import { describe, expect, it } from 'vitest';
import { hashApiKey, parseApiKeyPermissions } from './api-key-auth.js';

describe('API-key authentication helpers', () => {
  it('uses stable SHA-256 hashing without exposing plaintext', () => {
    const token = 'wrk_test-secret';
    const hash = hashApiKey(token);
    expect(hash).toMatch(/^[a-f0-9]{64}$/u);
    expect(hash).toBe(hashApiKey(token));
    expect(hash).not.toContain(token);
  });

  it('rejects malformed or unknown scope sets and deduplicates valid scopes', () => {
    expect(parseApiKeyPermissions(JSON.stringify(['monitor:read', 'monitor:read']))).toEqual([
      'monitor:read',
    ]);
    expect(parseApiKeyPermissions(JSON.stringify(['monitor:read', 'unknown:action']))).toBeNull();
    expect(parseApiKeyPermissions('[]')).toBeNull();
    expect(parseApiKeyPermissions('not-json')).toBeNull();
    expect(parseApiKeyPermissions(null)).toBeNull();
  });
});
