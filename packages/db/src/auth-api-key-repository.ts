import { and, desc, eq, gt, isNull, or } from 'drizzle-orm';
import type { WatchrailDatabase } from './client.js';
import { authApiKey, authMember } from './schema.js';

export interface AuthApiKeyIdentity {
  id: string;
  userId: string;
  organizationId: string;
  role: string;
  permissions: string | null;
}

export class AuthApiKeyRepository {
  constructor(private readonly db: WatchrailDatabase) {}

  async create(input: {
    name: string;
    keyHash: string;
    start: string;
    prefix: string;
    userId: string;
    organizationId: string;
    permissions: string;
    expiresAt: Date | null;
  }) {
    const [created] = await this.db
      .insert(authApiKey)
      .values({
        ...input,
        key: input.keyHash,
        enabled: true,
      })
      .returning();
    if (!created) throw new Error('PostgreSQL did not return the created API credential.');
    return created;
  }

  list(organizationId: string) {
    return this.db
      .select()
      .from(authApiKey)
      .where(eq(authApiKey.organizationId, organizationId))
      .orderBy(desc(authApiKey.createdAt));
  }

  async revoke(organizationId: string, id: string): Promise<boolean> {
    const revoked = await this.db
      .update(authApiKey)
      .set({ enabled: false, updatedAt: new Date() })
      .where(and(eq(authApiKey.organizationId, organizationId), eq(authApiKey.id, id)))
      .returning({ id: authApiKey.id });
    return revoked.length === 1;
  }

  async authenticate(keyHash: string, now = new Date()): Promise<AuthApiKeyIdentity | null> {
    const [identity] = await this.db
      .select({
        id: authApiKey.id,
        userId: authApiKey.userId,
        organizationId: authApiKey.organizationId,
        role: authMember.role,
        permissions: authApiKey.permissions,
      })
      .from(authApiKey)
      .innerJoin(
        authMember,
        and(
          eq(authMember.userId, authApiKey.userId),
          eq(authMember.organizationId, authApiKey.organizationId),
        ),
      )
      .where(
        and(
          eq(authApiKey.key, keyHash),
          eq(authApiKey.enabled, true),
          or(isNull(authApiKey.expiresAt), gt(authApiKey.expiresAt, now)),
        ),
      )
      .limit(1);
    return identity ?? null;
  }
}
