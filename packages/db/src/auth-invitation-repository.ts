import { and, eq } from 'drizzle-orm';
import type { WatchrailDatabase } from './client.js';
import { authInvitation } from './schema.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export class AuthInvitationRepository {
  constructor(private readonly db: WatchrailDatabase) {}

  async belongsToOrganization(organizationId: string, invitationId: string): Promise<boolean> {
    if (!UUID_PATTERN.test(invitationId)) return false;

    const [invitation] = await this.db
      .select({ id: authInvitation.id })
      .from(authInvitation)
      .where(
        and(
          eq(authInvitation.organizationId, organizationId),
          eq(authInvitation.id, invitationId),
        ),
      )
      .limit(1);
    return invitation !== undefined;
  }
}
