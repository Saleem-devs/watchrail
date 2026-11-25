import { describe, expect, it, vi } from 'vitest';
import {
  clearPendingAuthMethod,
  commitAuthMethod,
  readLastUsedAuthMethod,
  rememberPendingAuthMethod,
} from './auth-method-preference';

describe('auth method preference', () => {
  it('records a pending social method only after the callback commits it', () => {
    const persistent = memoryStorage();
    const transient = memoryStorage();

    rememberPendingAuthMethod('github', transient);

    expect(readLastUsedAuthMethod(persistent)).toBeNull();
    expect(commitAuthMethod(undefined, persistent, transient)).toBe('github');
    expect(readLastUsedAuthMethod(persistent)).toBe('github');
    expect(transient.getItem('watchrail:pending-auth-method')).toBeNull();
  });

  it('records a successful email verification explicitly', () => {
    const persistent = memoryStorage();
    const transient = memoryStorage();

    rememberPendingAuthMethod('google', transient);
    expect(commitAuthMethod('email', persistent, transient)).toBe('email');
    expect(readLastUsedAuthMethod(persistent)).toBe('email');
  });

  it('ignores unknown and unavailable storage values without blocking authentication', () => {
    const invalid = memoryStorage({ 'watchrail:last-used-auth-method': 'password' });
    expect(readLastUsedAuthMethod(invalid)).toBeNull();

    const unavailable = {
      getItem: vi.fn(() => {
        throw new Error('Storage denied');
      }),
      setItem: vi.fn(() => {
        throw new Error('Storage denied');
      }),
      removeItem: vi.fn(() => {
        throw new Error('Storage denied');
      }),
    };

    expect(readLastUsedAuthMethod(unavailable)).toBeNull();
    expect(() => rememberPendingAuthMethod('gitlab', unavailable)).not.toThrow();
    expect(() => clearPendingAuthMethod(unavailable)).not.toThrow();
    expect(() => commitAuthMethod('gitlab', unavailable, unavailable)).not.toThrow();
  });
});

function memoryStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  };
}
