import { createHash, randomUUID } from 'node:crypto';
import { and, eq, gt, isNull, lte, sql } from 'drizzle-orm';
import type { WatchrailDatabase } from './client.js';
import { authEmailOutbox, authInvitation } from './schema.js';
import { encryptAuthEmail, type AuthEmailKeyring } from './auth-email-security.js';

export class AuthEmailOutboxRepository {
  constructor(private readonly db: WatchrailDatabase) {}

  async stage(input: {
    kind: 'OTP' | 'INVITATION';
    recipient: string;
    supersessionKey: string;
    payload: unknown;
    expiresAt: Date;
    keyring: AuthEmailKeyring;
  }): Promise<string> {
    const id = randomUUID();
    const supersessionKey = createHash('sha256').update(input.supersessionKey).digest('hex');
    await this.db.transaction(async (tx) => {
      // Serialize staging by logical recipient/purpose, including the empty-set case.
      // Row locks alone cannot stop two concurrent inserts both appearing active.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${supersessionKey}, 0))`);
      await tx
        .update(authEmailOutbox)
        .set({ supersededAt: new Date() })
        .where(
          and(
            eq(authEmailOutbox.supersessionKey, supersessionKey),
            isNull(authEmailOutbox.deliveredAt),
            isNull(authEmailOutbox.supersededAt),
          ),
        );
      await tx.insert(authEmailOutbox).values({
        id,
        kind: input.kind,
        recipientHash: createHash('sha256').update(input.recipient.toLowerCase()).digest('hex'),
        supersessionKey,
        encryptedPayload: encryptAuthEmail(input.payload, id, input.keyring),
        expiresAt: input.expiresAt,
      });
    });
    return id;
  }

  async claimNext(leaseMs: number) {
    const now = new Date();
    await this.db
      .update(authEmailOutbox)
      .set({ failedAt: now, lastErrorCode: 'EXPIRED' })
      .where(
        and(
          isNull(authEmailOutbox.deliveredAt),
          isNull(authEmailOutbox.supersededAt),
          isNull(authEmailOutbox.failedAt),
          lte(authEmailOutbox.expiresAt, now),
        ),
      );

    const result = await this.db.execute<{
      id: string;
      claimToken: string;
      expiresAt: Date;
    }>(sql`
      with candidate as (
        select id from auth_email_outbox
        where published_at is null and superseded_at is null and failed_at is null
          and expires_at > clock_timestamp()
          and available_at <= clock_timestamp()
          and (lease_expires_at is null or lease_expires_at <= clock_timestamp())
        order by available_at, id for update skip locked limit 1
      )
      update auth_email_outbox o set
        claim_token = gen_random_uuid(),
        lease_expires_at = clock_timestamp() + (${leaseMs} * interval '1 millisecond'),
        attempt_count = o.attempt_count + 1
      from candidate where o.id = candidate.id
      returning o.id, o.claim_token as "claimToken", o.expires_at as "expiresAt"
    `);
    return result.rows[0] ?? null;
  }

  async markPublished(id: string, claimToken: string): Promise<boolean> {
    const rows = await this.db
      .update(authEmailOutbox)
      .set({ publishedAt: new Date(), claimToken: null, leaseExpiresAt: null })
      .where(and(eq(authEmailOutbox.id, id), eq(authEmailOutbox.claimToken, claimToken)))
      .returning({ id: authEmailOutbox.id });
    return rows.length === 1;
  }

  async release(id: string, claimToken: string, availableAt: Date, code: string): Promise<boolean> {
    const rows = await this.db
      .update(authEmailOutbox)
      .set({ availableAt, lastErrorCode: code, claimToken: null, leaseExpiresAt: null })
      .where(and(eq(authEmailOutbox.id, id), eq(authEmailOutbox.claimToken, claimToken)))
      .returning({ id: authEmailOutbox.id });
    return rows.length === 1;
  }

  /** Cancel any pending delivery for an invitation, including already-published jobs. */
  async supersedeInvitation(invitationId: string): Promise<void> {
    const key = createHash('sha256').update(`invitation:${invitationId}`).digest('hex');
    await this.db
      .update(authEmailOutbox)
      .set({ supersededAt: new Date() })
      .where(
        and(
          eq(authEmailOutbox.supersessionKey, key),
          eq(authEmailOutbox.kind, 'INVITATION'),
          isNull(authEmailOutbox.deliveredAt),
          isNull(authEmailOutbox.supersededAt),
          isNull(authEmailOutbox.failedAt),
        ),
      );
  }

  /** Validate against authoritative Better Auth state, including direct plugin API changes. */
  async isInvitationPending(invitationId: string, now = new Date()): Promise<boolean> {
    const [active] = await this.db
      .select({ id: authInvitation.id })
      .from(authInvitation)
      .where(
        and(
          eq(authInvitation.id, invitationId),
          eq(authInvitation.status, 'pending'),
          gt(authInvitation.expiresAt, now),
        ),
      )
      .limit(1);
    return Boolean(active);
  }

  async forDelivery(id: string, now = new Date()) {
    // BullMQ may dispatch after expiry, even if the row was already published.
    // Record a terminal state instead of silently acknowledging the stale job.
    await this.db
      .update(authEmailOutbox)
      .set({ failedAt: now, lastErrorCode: 'EXPIRED' })
      .where(
        and(
          eq(authEmailOutbox.id, id),
          isNull(authEmailOutbox.deliveredAt),
          isNull(authEmailOutbox.supersededAt),
          isNull(authEmailOutbox.failedAt),
          lte(authEmailOutbox.expiresAt, now),
        ),
      );
    const [message] = await this.db
      .select()
      .from(authEmailOutbox)
      .where(
        and(
          eq(authEmailOutbox.id, id),
          isNull(authEmailOutbox.supersededAt),
          isNull(authEmailOutbox.deliveredAt),
          isNull(authEmailOutbox.failedAt),
          sql`${authEmailOutbox.expiresAt} > ${now}`,
        ),
      )
      .limit(1);
    return message ?? null;
  }

  async markDelivered(id: string): Promise<void> {
    await this.db
      .update(authEmailOutbox)
      .set({ deliveredAt: new Date(), lastErrorCode: null })
      .where(and(eq(authEmailOutbox.id, id), isNull(authEmailOutbox.deliveredAt)));
  }

  async markFailed(id: string, code: string): Promise<void> {
    await this.db
      .update(authEmailOutbox)
      .set({ failedAt: new Date(), lastErrorCode: code })
      .where(
        and(
          eq(authEmailOutbox.id, id),
          isNull(authEmailOutbox.deliveredAt),
          isNull(authEmailOutbox.failedAt),
        ),
      );
  }
}
