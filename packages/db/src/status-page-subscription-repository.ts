import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import type { WatchrailDatabase } from './client.js';
import { encryptAuthEmail, type AuthEmailKeyring } from './auth-email-security.js';
import { statusPageSubscribers, statusPageEmailDeliveries, statusPages } from './schema.js';

export const subscriptionTokenHash = (value: string) =>
  createHash('sha256').update(value).digest('hex');

export class StatusPageSubscriptionRepository {
  constructor(private readonly db: WatchrailDatabase) {}

  /** Shared database limits apply across API replicas; keys never contain raw email/IP. */
  async consumeLimit(key: string, maximum: number): Promise<boolean> {
    const result = await this.db.execute<{ count: number }>(sql`
      insert into status_page_subscription_limits (key, count, resets_at)
      values (${subscriptionTokenHash(key)}, 1, clock_timestamp() + interval '1 hour')
      on conflict (key) do update set
        count = case when status_page_subscription_limits.resets_at <= clock_timestamp() then 1
                     else least(status_page_subscription_limits.count + 1, 1000000) end,
        resets_at = case when status_page_subscription_limits.resets_at <= clock_timestamp()
                        then clock_timestamp() + interval '1 hour' else status_page_subscription_limits.resets_at end
      returning count`);
    return result.rows[0]!.count <= maximum;
  }

  async request(slug: string, email: string, keyring: AuthEmailKeyring): Promise<void> {
    const canonical = email.trim().toLowerCase();
    // Per-address global limits prevent targeting one mailbox through many pages.
    if (!(await this.consumeLimit(`email:${canonical}`, 5))) return;
    await this.db.transaction(async (tx) => {
      const [page] = await tx
        .select()
        .from(statusPages)
        .where(and(eq(statusPages.slug, slug), eq(statusPages.published, true)))
        .for('share');
      if (!page) return;
      const hash = subscriptionTokenHash(canonical);
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${page.id + hash}, 0))`);
      const [existing] = await tx
        .select()
        .from(statusPageSubscribers)
        .where(
          and(
            eq(statusPageSubscribers.statusPageId, page.id),
            eq(statusPageSubscribers.emailHash, hash),
          ),
        )
        .for('update');
      const clock = await tx.execute<{ now: string }>(sql`select clock_timestamp() as now`);
      const now = new Date(clock.rows[0]!.now);
      if (
        existing?.state === 'ACTIVE' ||
        (existing && now.getTime() - existing.requestedAt.getTime() < 60_000)
      )
        return;
      const id = existing?.id ?? randomUUID();
      const generation = randomUUID();
      const verification = randomBytes(32).toString('base64url');
      const unsubscribe = randomBytes(32).toString('base64url');
      const values = {
        id,
        generation,
        organizationId: page.organizationId,
        statusPageId: page.id,
        emailHash: hash,
        encryptedDetails: encryptAuthEmail(
          { email: canonical, unsubscribe },
          `subscriber:${id}:${generation}`,
          keyring,
        ),
        state: 'PENDING',
        verificationHash: subscriptionTokenHash(verification),
        unsubscribeHash: subscriptionTokenHash(unsubscribe),
        expiresAt: new Date(now.getTime() + 24 * 60 * 60_000),
        confirmedAt: null,
        requestedAt: now,
      };
      await tx
        .insert(statusPageSubscribers)
        .values(values)
        .onConflictDoUpdate({ target: statusPageSubscribers.id, set: values });
      // A new request invalidates older verification mail and old-generation events.
      await tx.execute(sql`update status_page_email_deliveries set state = 'SUPPRESSED', completed_at = clock_timestamp(), claim_token = null
        where subscriber_id = ${id} and state in ('PENDING', 'SENDING')`);
      const deliveryId = randomUUID();
      await tx.insert(statusPageEmailDeliveries).values({
        id: deliveryId,
        organizationId: page.organizationId,
        statusPageId: page.id,
        subscriberId: id,
        generation,
        kind: 'VERIFY',
        encryptedPayload: encryptAuthEmail(
          { verification },
          `status-verification:${deliveryId}`,
          keyring,
        ),
      });
    });
  }

  async publicPageSlug(token: string, kind: 'verify' | 'unsubscribe'): Promise<string | null> {
    if (!/^[\w-]{43}$/u.test(token)) return null;
    const column = kind === 'verify' ? sql`s.verification_hash` : sql`s.unsubscribe_hash`;
    const result = await this.db.execute<{ slug: string }>(sql`
      select p.slug from status_page_subscribers s
      join status_pages p on p.id = s.status_page_id and p.organization_id = s.organization_id
      where p.published and ${column} = ${subscriptionTokenHash(token)} limit 1`);
    return result.rows[0]?.slug ?? null;
  }

  async confirm(token: string): Promise<boolean> {
    if (!/^[\w-]{43}$/u.test(token)) return false;
    const result = await this.db.execute(sql`
      update status_page_subscribers s set state = 'ACTIVE', confirmed_at = coalesce(confirmed_at, clock_timestamp())
      from status_pages p where p.id = s.status_page_id and p.organization_id = s.organization_id and p.published
        and s.verification_hash = ${subscriptionTokenHash(token)} and s.state in ('PENDING', 'ACTIVE')
        and (s.state = 'ACTIVE' or s.expires_at > clock_timestamp()) returning s.id`);
    return result.rows.length === 1;
  }

  async unsubscribe(token: string): Promise<void> {
    if (!/^[\w-]{43}$/u.test(token)) return;
    await this.db.transaction(async (tx) => {
      const result = await tx.execute<{
        id: string;
      }>(sql`update status_page_subscribers set state = 'UNSUBSCRIBED'
        where unsubscribe_hash = ${subscriptionTokenHash(token)} returning id`);
      if (!result.rows[0]) return;
      await tx.execute(sql`update status_page_email_deliveries set state = 'SUPPRESSED', completed_at = clock_timestamp(), claim_token = null
        where subscriber_id = ${result.rows[0].id} and state in ('PENDING', 'SENDING')`);
    });
  }

  async expandNext(): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      const result = await tx.execute<{
        id: string;
      }>(sql`select e.id from status_page_email_events e
        join status_pages p on p.id = e.status_page_id and p.organization_id = e.organization_id
        where e.expanded_at is null order by e.created_at, e.id
        for update of e skip locked for share of p skip locked limit 1`);
      const id = result.rows[0]?.id;
      if (!id) return false;
      await tx.execute(sql`insert into status_page_email_deliveries
        (organization_id, status_page_id, subscriber_id, generation, event_id, kind)
        select e.organization_id, e.status_page_id, s.id, s.generation, e.id, 'EVENT'
        from status_page_email_events e
        join status_page_subscribers s on s.status_page_id = e.status_page_id and s.organization_id = e.organization_id
        join status_pages p on p.id = e.status_page_id and p.organization_id = e.organization_id
        where e.id = ${id} and p.published and s.state = 'ACTIVE' and s.confirmed_at <= e.created_at
        on conflict do nothing`);
      await tx.execute(
        sql`update status_page_email_events set expanded_at = clock_timestamp() where id = ${id}`,
      );
      return true;
    });
  }

  async claimNext(leaseMs: number) {
    const result = await this.db.execute<{ id: string; token: string; attempts: number }>(sql`
      with candidate as (select id from status_page_email_deliveries
        where (state = 'PENDING' and available_at <= clock_timestamp())
           or (state = 'SENDING' and lease_expires_at <= clock_timestamp())
        order by available_at, id for update skip locked limit 1)
      update status_page_email_deliveries d set state = 'SENDING', claim_token = gen_random_uuid(),
        lease_expires_at = clock_timestamp() + (${leaseMs} * interval '1 millisecond'), attempt_count = attempt_count + 1
      from candidate where candidate.id = d.id
      returning d.id, d.claim_token as token, d.attempt_count as attempts`);
    return result.rows[0] ?? null;
  }

  async authorize(id: string, token: string) {
    // This is the dispatch authorization boundary; already-accepted SMTP mail cannot be recalled.
    const result = await this.db.execute<{
      kind: string;
      details: unknown;
      payload: unknown;
      subscriberId: string;
      generation: string;
      name: string;
      slug: string;
      subject: string | null;
      body: string | null;
      remainingMs: number;
    }>(sql`select d.kind, s.encrypted_details as details, d.encrypted_payload as payload,
      s.id as "subscriberId", s.generation, p.name, p.slug, e.subject, e.body,
      floor(extract(epoch from (d.lease_expires_at - clock_timestamp())) * 1000)::int as "remainingMs"
      from status_page_email_deliveries d
      join status_page_subscribers s on s.id = d.subscriber_id and s.organization_id = d.organization_id and s.status_page_id = d.status_page_id
      join status_pages p on p.id = d.status_page_id and p.organization_id = d.organization_id
      left join status_page_email_events e on e.id = d.event_id and e.status_page_id = d.status_page_id and e.organization_id = d.organization_id
      where d.id = ${id} and d.claim_token = ${token} and d.state = 'SENDING' and d.lease_expires_at > clock_timestamp()
        and p.published and s.generation = d.generation
        and ((d.kind = 'VERIFY' and s.state = 'PENDING' and s.expires_at > clock_timestamp())
          or (d.kind = 'EVENT' and s.state = 'ACTIVE'))`);
    return result.rows[0] ?? null;
  }

  async finish(
    id: string,
    token: string,
    state: 'DELIVERED' | 'SUPPRESSED' | 'DEAD' | 'PENDING',
    error: string | null = null,
    delayMs = 0,
  ): Promise<boolean> {
    const result = await this.db
      .execute(sql`update status_page_email_deliveries set state = ${state},
      last_error_code = ${error}, claim_token = null, lease_expires_at = null,
      completed_at = case when ${state} = 'PENDING' then null else clock_timestamp() end,
      available_at = clock_timestamp() + (${delayMs} * interval '1 millisecond')
      where id = ${id} and claim_token = ${token} and state = 'SENDING' and lease_expires_at > clock_timestamp() returning id`);
    return result.rows.length === 1;
  }
}
