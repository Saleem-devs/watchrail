import { describe, expect, it } from 'vitest';
import { safeNextPath } from './safe-next-path';

describe('safeNextPath', () => {
  it('preserves an internal path with its invitation query', () => {
    expect(safeNextPath('/accept-invitation?id=invitation-1')).toBe(
      '/accept-invitation?id=invitation-1',
    );
  });

  it.each([
    'https://attacker.example/path',
    '//attacker.example/path',
    'javascript:alert(1)',
    null,
  ])('rejects external or malformed destinations', (value) => {
    expect(safeNextPath(value)).toBe('/');
  });
});
