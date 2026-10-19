import { describe, expect, it } from 'vitest';
import { createApiCredentialSchema } from './create-api-credential.input.js';

describe('createApiCredentialSchema', () => {
  const valid = { name: ' Automation ', permissions: ['monitor:read'] };

  it('accepts and trims valid input with optional expiry', () => {
    expect(createApiCredentialSchema.parse(valid)).toEqual({
      name: 'Automation',
      permissions: ['monitor:read'],
    });
    expect(
      createApiCredentialSchema.safeParse({
        ...valid,
        expiresAt: null,
      }).success,
    ).toBe(true);
  });

  it('rejects unknown fields, invalid permissions and malformed input', () => {
    for (const candidate of [
      { ...valid, organizationId: 'client-controlled' },
      { ...valid, permissions: ['*'] },
      { ...valid, permissions: [] },
      { ...valid, permissions: 'monitor:read' },
      { ...valid, expiresAt: 42 },
      { ...valid, name: '  ' },
      { ...valid, name: 'x'.repeat(121) },
    ]) {
      expect(createApiCredentialSchema.safeParse(candidate).success).toBe(false);
    }
  });
});
