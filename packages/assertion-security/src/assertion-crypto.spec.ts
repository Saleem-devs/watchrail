import { describe, expect, it } from 'vitest';
import { EMPTY_ASSERTION_CONFIGURATION } from '@watchrail/domain';
import {
  AssertionRetentionError,
  loadAssertionEncryptionKeyring,
  resolveResponseAssertions,
  storeResponseAssertions,
  StoredAssertionResolutionError,
  type AssertionEncryptionKeyring,
} from './assertion-crypto.js';

const context = {
  organizationId: '11111111-1111-4111-8111-111111111111',
  monitorId: '22222222-2222-4222-8222-222222222222',
};
const keyring: AssertionEncryptionKeyring = {
  activeKeyId: 'v1',
  keys: new Map([['v1', Buffer.alloc(32, 7)]]),
};

describe('assertion encryption', () => {
  it.each([
    ['NUL-heavy', '\u0000'.repeat(4_096)],
    ['lone-surrogate', String.fromCharCode(0xd800).repeat(4_096)],
  ])('round-trips a maximum-length %s sensitive JSON string', (_case, value) => {
    const stored = storeResponseAssertions(
      {
        headers: [],
        textBody: [],
        jsonBody: [
          {
            selector: '$.value',
            operator: 'equals',
            target: { sensitive: true, value: { type: 'string', value } },
          },
        ],
      },
      EMPTY_ASSERTION_CONFIGURATION,
      'GET',
      context,
      keyring,
      { allowRetain: false },
    );

    expect(stored.assertions.jsonBody[0]).toMatchObject({
      target: { sensitive: true },
    });
    expect(JSON.stringify(stored)).not.toContain(value);
    expect(resolveResponseAssertions(stored, 'GET', context, keyring)).toEqual({
      headers: [],
      textBody: [],
      jsonBody: [
        {
          selector: '$.value',
          operator: 'equals',
          target: { sensitive: true, value: { type: 'string', value } },
        },
      ],
    });
  });

  it('rejects an active key ID beyond the stored-envelope bound at startup', () => {
    expect(() =>
      loadAssertionEncryptionKeyring({
        ASSERTION_ACTIVE_KEY_ID: 'x'.repeat(121),
        ASSERTION_ENCRYPTION_KEYS: JSON.stringify({
          ['x'.repeat(121)]: Buffer.alloc(32).toString('base64'),
        }),
      }),
    ).toThrow('Every assertion encryption key');
  });

  it('encrypts every sensitive target, preserves plaintext targets, and resolves all categories', () => {
    const secret = '🔐'.repeat(2_048);
    const stored = storeResponseAssertions(
      {
        headers: [
          {
            name: 'x-token',
            operator: 'equals',
            target: { sensitive: true, value: secret },
          },
          {
            name: 'content-type',
            operator: 'contains',
            target: { sensitive: false, value: 'json' },
          },
        ],
        textBody: [{ operator: 'contains', target: { sensitive: true, value: 'private-text' } }],
        jsonBody: [
          {
            selector: '$.token',
            operator: 'equals',
            target: { sensitive: true, value: { type: 'string', value: 'private-json' } },
          },
        ],
      },
      EMPTY_ASSERTION_CONFIGURATION,
      'GET',
      context,
      keyring,
      { allowRetain: false },
    );

    expect(JSON.stringify(stored)).not.toContain(secret);
    expect(JSON.stringify(stored)).not.toContain('private-text');
    expect(JSON.stringify(stored)).not.toContain('private-json');
    expect(JSON.stringify(stored)).toContain('json');
    expect(resolveResponseAssertions(stored, 'GET', context, keyring)).toMatchObject({
      headers: [
        { target: { sensitive: true, value: secret } },
        { target: { sensitive: false, value: 'json' } },
      ],
      textBody: [{ target: { sensitive: true, value: 'private-text' } }],
      jsonBody: [
        {
          target: {
            sensitive: true,
            value: { type: 'string', value: 'private-json' },
          },
        },
      ],
    });
  });

  it('retains only a compatible sensitive target at the same source-local index', () => {
    const original = storeResponseAssertions(
      {
        headers: [],
        textBody: [{ operator: 'equals', target: { sensitive: true, value: 'secret' } }],
        jsonBody: [],
      },
      EMPTY_ASSERTION_CONFIGURATION,
      'GET',
      context,
      keyring,
      { allowRetain: false },
    );
    const retained = storeResponseAssertions(
      {
        headers: [],
        textBody: [{ operator: 'equals', target: { sensitive: true, retain: true } }],
        jsonBody: [],
      },
      original,
      'GET',
      context,
      keyring,
      { allowRetain: true },
    );
    expect(retained).toEqual(original);

    expect(() =>
      storeResponseAssertions(
        {
          headers: [],
          textBody: [{ operator: 'contains', target: { sensitive: true, retain: true } }],
          jsonBody: [],
        },
        original,
        'GET',
        context,
        keyring,
        { allowRetain: true },
      ),
    ).toThrow(AssertionRetentionError);
  });

  it('rejects retain during creation', () => {
    expect(() =>
      storeResponseAssertions(
        {
          headers: [],
          textBody: [{ operator: 'equals', target: { sensitive: true, retain: true } }],
          jsonBody: [],
        },
        EMPTY_ASSERTION_CONFIGURATION,
        'GET',
        context,
        keyring,
        { allowRetain: false },
      ),
    ).toThrow(AssertionRetentionError);
  });

  it('authenticates the complete assertion identity and monitor context', () => {
    const stored = storeResponseAssertions(
      {
        headers: [],
        textBody: [{ operator: 'equals', target: { sensitive: true, value: 'secret' } }],
        jsonBody: [],
      },
      EMPTY_ASSERTION_CONFIGURATION,
      'GET',
      context,
      keyring,
      { allowRetain: false },
    );

    expect(() =>
      resolveResponseAssertions(
        stored,
        'GET',
        { ...context, monitorId: '33333333-3333-4333-8333-333333333333' },
        keyring,
      ),
    ).toThrow(StoredAssertionResolutionError);

    const tampered = structuredClone(stored);
    tampered.assertions.textBody[0]!.operator = 'contains';
    expect(() => resolveResponseAssertions(tampered, 'GET', context, keyring)).toThrow(
      StoredAssertionResolutionError,
    );
  });
});
