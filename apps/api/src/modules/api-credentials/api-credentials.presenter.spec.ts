import { describe, expect, it } from 'vitest';
import {
  presentApiCredential,
  presentCreatedApiCredential,
  type ApiCredentialPresentationRecord,
} from './api-credentials.presenter.js';

describe('API credential presenters', () => {
  const record = {
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    name: 'Automation',
    start: 'wrk_abcd',
    enabled: true,
    permissions: '["monitor:read","check:read"]',
    expiresAt: new Date('2027-01-01T00:00:00.000Z'),
    createdAt: new Date('2026-10-19T00:00:00.000Z'),
    updatedAt: new Date('2026-10-19T00:01:00.000Z'),
    organizationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    userId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    key: 'private-hash',
    keyHash: 'private-hash',
  } satisfies ApiCredentialPresentationRecord & {
    organizationId: string;
    userId: string;
    key: string;
    keyHash: string;
  };

  it('returns a metadata-only allow-list without credentials or tenant identity', () => {
    const result = presentApiCredential(record);
    expect(result).toEqual({
      id: record.id,
      name: record.name,
      start: record.start,
      enabled: true,
      permissions: ['monitor:read', 'check:read'],
      expiresAt: '2027-01-01T00:00:00.000Z',
      createdAt: '2026-10-19T00:00:00.000Z',
      updatedAt: '2026-10-19T00:01:00.000Z',
    });
    for (const field of ['organizationId', 'userId', 'key', 'keyHash', 'token']) {
      expect(result).not.toHaveProperty(field);
    }
  });

  it('includes the plaintext token only in the one-time creation projection', () => {
    const token = 'wrk_one-time-token';
    expect(presentCreatedApiCredential(record, token)).toEqual({
      ...presentApiCredential(record),
      token,
    });
  });

  it('treats corrupted stored scopes as empty instead of exposing raw JSON', () => {
    expect(presentApiCredential({ ...record, permissions: 'malformed' }).permissions).toEqual([]);
  });
});
