import { createHash } from 'node:crypto';
import { PERMISSIONS, type Permission } from '../../permissions.js';

const ALL_PERMISSIONS = new Set<string>(Object.values(PERMISSIONS));

export function hashApiKey(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function parseApiKeyPermissions(value: string | null): Permission[] | null {
  if (!value) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    if (
      !Array.isArray(parsed) ||
      parsed.length === 0 ||
      parsed.some(
        (permission) => typeof permission !== 'string' || !ALL_PERMISSIONS.has(permission),
      )
    ) {
      return null;
    }
    return [...new Set(parsed)] as Permission[];
  } catch {
    return null;
  }
}
