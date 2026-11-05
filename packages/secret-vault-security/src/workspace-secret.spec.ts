import { describe, expect, it } from 'vitest';
import {
  decryptWorkspaceSecret,
  encryptWorkspaceSecret,
  loadWorkspaceSecretKeyring,
  parseStoredWorkspaceSecret,
  StoredWorkspaceSecretResolutionError,
  WorkspaceSecretInputError,
} from './workspace-secret.js';

const context = {
  organizationId: '10000000-0000-4000-8000-000000000001',
  secretId: '20000000-0000-4000-8000-000000000002',
  versionNumber: 1,
};
const keyring = {
  activeKeyId: 'v1',
  keys: new Map([['v1', Buffer.alloc(32, 7)]]),
};

describe('workspace secret encryption', () => {
  it('encrypts non-deterministically and binds ciphertext to tenant, identity and version', () => {
    const first = encryptWorkspaceSecret('secret-value', context, keyring);
    const second = encryptWorkspaceSecret('secret-value', context, keyring);

    expect(first).not.toEqual(second);
    expect(JSON.stringify(first)).not.toContain('secret-value');
    expect(decryptWorkspaceSecret(first, context, keyring)).toBe('secret-value');
    expect(() => decryptWorkspaceSecret(first, { ...context, versionNumber: 2 }, keyring)).toThrow(
      StoredWorkspaceSecretResolutionError,
    );
    expect(() =>
      decryptWorkspaceSecret(
        first,
        { ...context, organizationId: '30000000-0000-4000-8000-000000000003' },
        keyring,
      ),
    ).toThrow(StoredWorkspaceSecretResolutionError);
    expect(() =>
      decryptWorkspaceSecret(
        first,
        { ...context, secretId: '40000000-0000-4000-8000-000000000004' },
        keyring,
      ),
    ).toThrow(StoredWorkspaceSecretResolutionError);
  });

  it('retains old-key decryptability while new writes use the active key', () => {
    const old = encryptWorkspaceSecret('secret-value', context, {
      activeKeyId: 'old',
      keys: new Map([['old', Buffer.alloc(32, 3)]]),
    });
    const rotated = {
      activeKeyId: 'new',
      keys: new Map([
        ['old', Buffer.alloc(32, 3)],
        ['new', Buffer.alloc(32, 4)],
      ]),
    };

    expect(decryptWorkspaceSecret(old, context, rotated)).toBe('secret-value');
    expect(encryptWorkspaceSecret('replacement', context, rotated).keyId).toBe('new');
  });

  it('strictly validates values, envelopes and keyrings', () => {
    expect(() => encryptWorkspaceSecret('', context, keyring)).toThrow(WorkspaceSecretInputError);
    expect(() => encryptWorkspaceSecret('x'.repeat(8_193), context, keyring)).toThrow(
      WorkspaceSecretInputError,
    );
    expect(() => parseStoredWorkspaceSecret({ plaintext: 'secret-value' })).toThrow(
      'Stored workspace-secret envelope is invalid.',
    );
    expect(() =>
      loadWorkspaceSecretKeyring({
        WORKSPACE_SECRET_ACTIVE_KEY_ID: 'v1',
        WORKSPACE_SECRET_ENCRYPTION_KEYS: '{bad-json',
      }),
    ).toThrow('must be a JSON object');
  });
});
