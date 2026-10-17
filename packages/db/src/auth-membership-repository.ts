import { and, eq } from 'drizzle-orm';
import type { WatchrailDatabase } from './client.js';
import { authMember } from './schema.js';

export class AuthMembershipInvariantError extends Error {}

/** Read-only Better Auth membership lookup used at the API trust boundary. */
export class AuthMembershipRepository {
  constructor(private readonly db: WatchrailDatabase) {}

  async roleForUser(userId: string, organizationId: string): Promise<string | null> {
    const [member] = await this.db
      .select({ role: authMember.role })
      .from(authMember)
      .where(and(eq(authMember.userId, userId), eq(authMember.organizationId, organizationId)))
      .limit(1);

    return member?.role ?? null;
  }

  async transferOwnership(
    organizationId: string,
    currentOwnerUserId: string,
    newOwnerUserId: string,
  ): Promise<void> {
    if (currentOwnerUserId === newOwnerUserId) return;

    await this.db.transaction(async (tx) => {
      const members = await tx
        .select({ id: authMember.id, userId: authMember.userId, role: authMember.role })
        .from(authMember)
        .where(eq(authMember.organizationId, organizationId))
        .for('update');

      const currentOwner = members.find(
        (member) => member.userId === currentOwnerUserId && member.role === 'owner',
      );
      if (!currentOwner) {
        throw new AuthMembershipInvariantError(
          'The current actor is not an owner of this organization.',
        );
      }

      const nextOwner = members.find((member) => member.userId === newOwnerUserId);
      if (!nextOwner) {
        throw new AuthMembershipInvariantError(
          'The target user is not a member of this organization.',
        );
      }

      await tx.update(authMember).set({ role: 'owner' }).where(eq(authMember.id, nextOwner.id));
      await tx.update(authMember).set({ role: 'admin' }).where(eq(authMember.id, currentOwner.id));
    });
  }
}
