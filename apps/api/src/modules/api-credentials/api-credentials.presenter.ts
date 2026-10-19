import type { AuthApiKeyRepository } from '@watchrail/db';
import { parseApiKeyPermissions } from './api-key-auth.js';

export type ApiCredentialPresentationRecord = Pick<
  Awaited<ReturnType<AuthApiKeyRepository['create']>>,
  'id' | 'name' | 'start' | 'enabled' | 'permissions' | 'expiresAt' | 'createdAt' | 'updatedAt'
>;

export function presentApiCredential(record: ApiCredentialPresentationRecord) {
  return {
    id: record.id,
    name: record.name,
    start: record.start,
    enabled: record.enabled,
    permissions: parseApiKeyPermissions(record.permissions) ?? [],
    expiresAt: record.expiresAt?.toISOString() ?? null,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

export function presentCreatedApiCredential(
  record: ApiCredentialPresentationRecord,
  token: string,
) {
  return {
    ...presentApiCredential(record),
    token,
  };
}
