export const AUTH_METHODS = ['github', 'gitlab', 'google', 'email'] as const;

export type AuthMethod = (typeof AUTH_METHODS)[number];

const LAST_USED_AUTH_METHOD_KEY = 'watchrail:last-used-auth-method';
const PENDING_AUTH_METHOD_KEY = 'watchrail:pending-auth-method';

export function readLastUsedAuthMethod(
  storage: Pick<Storage, 'getItem'> = localStorage,
): AuthMethod | null {
  return readAuthMethod(storage, LAST_USED_AUTH_METHOD_KEY);
}

export function rememberPendingAuthMethod(
  method: AuthMethod,
  storage: Pick<Storage, 'setItem'> = sessionStorage,
): void {
  safely(() => storage.setItem(PENDING_AUTH_METHOD_KEY, method));
}

export function clearPendingAuthMethod(
  storage: Pick<Storage, 'removeItem'> = sessionStorage,
): void {
  safely(() => storage.removeItem(PENDING_AUTH_METHOD_KEY));
}

export function commitAuthMethod(
  method?: AuthMethod,
  persistentStorage: Pick<Storage, 'setItem'> = localStorage,
  transientStorage: Pick<Storage, 'getItem' | 'removeItem'> = sessionStorage,
): AuthMethod | null {
  const resolved = method ?? readAuthMethod(transientStorage, PENDING_AUTH_METHOD_KEY);
  if (!resolved) return null;

  safely(() => persistentStorage.setItem(LAST_USED_AUTH_METHOD_KEY, resolved));
  safely(() => transientStorage.removeItem(PENDING_AUTH_METHOD_KEY));
  return resolved;
}

function readAuthMethod(storage: Pick<Storage, 'getItem'>, key: string): AuthMethod | null {
  try {
    const value = storage.getItem(key);
    return isAuthMethod(value) ? value : null;
  } catch {
    return null;
  }
}

function isAuthMethod(value: string | null): value is AuthMethod {
  return value !== null && AUTH_METHODS.some((method) => method === value);
}

function safely(operation: () => void): void {
  try {
    operation();
  } catch {
    // Authentication must keep working when browser storage is unavailable.
  }
}
