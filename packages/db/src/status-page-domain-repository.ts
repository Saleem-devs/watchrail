import { randomBytes } from 'node:crypto';
import { parse } from 'tldts';
import { isIP } from 'node:net';
import { and, eq, sql } from 'drizzle-orm';
import type { WatchrailDatabase } from './client.js';
import { statusPageDomains, statusPages } from './schema.js';
import { StatusPageNotFoundError } from './status-page-repository.js';

export function normalizeStatusHostname(value: string): string | null {
  const host = value.trim().toLowerCase();
  // Require an explicit ASCII DNS name. URLs, wildcard, ports and IP literals are not domains.
  const labels = host.split('.');
  if (
    host.length > 253 ||
    labels.length < 2 ||
    isIP(host) ||
    labels.some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(label)) ||
    !/[a-z]/u.test(labels.at(-1)!) ||
    ['localhost', 'local', 'internal', 'test', 'invalid'].includes(labels.at(-1)!)
  )
    return null;
  const parsed = parse(host, { allowPrivateDomains: true });
  if (!parsed.domain || !parsed.subdomain || (!parsed.isIcann && !parsed.isPrivate)) return null;
  return host;
}

export class StatusDomainConflictError extends Error {}
export class StatusDomainInputError extends Error {}
export type StatusPageDomainRecord = typeof statusPageDomains.$inferSelect;

export class StatusPageDomainRepository {
  constructor(private readonly db: WatchrailDatabase) {}

  async find(organizationId: string, statusPageId: string): Promise<StatusPageDomainRecord | null> {
    const page = await this.db
      .select({ id: statusPages.id })
      .from(statusPages)
      .where(and(eq(statusPages.id, statusPageId), eq(statusPages.organizationId, organizationId)));
    if (!page.length) throw new StatusPageNotFoundError();
    const [domain] = await this.db
      .select()
      .from(statusPageDomains)
      .where(
        and(
          eq(statusPageDomains.statusPageId, statusPageId),
          eq(statusPageDomains.organizationId, organizationId),
        ),
      );
    return domain ?? null;
  }

  async attach(organizationId: string, statusPageId: string, input: string) {
    const hostname = normalizeStatusHostname(input);
    if (!hostname)
      throw new StatusDomainInputError('Enter a bare hostname such as status.example.com.');
    return this.db.transaction(async (tx) => {
      const [page] = await tx
        .select({ id: statusPages.id })
        .from(statusPages)
        .where(
          and(eq(statusPages.id, statusPageId), eq(statusPages.organizationId, organizationId)),
        )
        .for('update');
      if (!page) throw new StatusPageNotFoundError();
      const [existing] = await tx
        .select()
        .from(statusPageDomains)
        .where(eq(statusPageDomains.statusPageId, statusPageId));
      if (existing?.hostname === hostname) return existing;
      if (existing)
        throw new StatusDomainConflictError('Remove the current domain before adding another.');
      const [created] = await tx
        .insert(statusPageDomains)
        .values({
          organizationId,
          statusPageId,
          hostname,
          verificationToken: randomBytes(32).toString('hex'),
        })
        .onConflictDoNothing()
        .returning();
      if (!created) throw new StatusDomainConflictError('This domain is already assigned.');
      return created;
    });
  }

  async remove(organizationId: string, statusPageId: string) {
    await this.find(organizationId, statusPageId);
    await this.db
      .delete(statusPageDomains)
      .where(
        and(
          eq(statusPageDomains.organizationId, organizationId),
          eq(statusPageDomains.statusPageId, statusPageId),
        ),
      );
  }

  async dueChecks() {
    const rows = await this.db.execute<{ organizationId: string; statusPageId: string }>(sql`
      select organization_id as "organizationId", status_page_id as "statusPageId" from status_page_domains
      where (verified_at is not null or last_checked_at is not null) and (last_checked_at is null or last_checked_at < clock_timestamp() - interval '6 hours'
        or (https_verified_at is null and last_checked_at < clock_timestamp() - interval '5 minutes'))
      order by last_checked_at limit 10`);
    return rows.rows;
  }

  async eligibleHostnames() {
    const rows = await this.db.execute<{ hostname: string }>(sql`
      select d.hostname from status_page_domains d join status_pages p on p.id=d.status_page_id and p.organization_id=d.organization_id
      where p.published and d.verified_at > clock_timestamp() - interval '24 hours'
        and d.routing_verified_at > clock_timestamp() - interval '24 hours' order by d.hostname`);
    return rows.rows.map((row) => row.hostname);
  }

  async resolve(hostname: string) {
    const rows = await this.db.execute<{
      id: string;
      pageId: string;
      slug: string;
      httpsReady: boolean;
    }>(sql`
      select d.id, p.id as "pageId", p.slug,
        (d.https_verified_at is not null and d.https_verified_at > clock_timestamp() - interval '24 hours') as "httpsReady"
      from status_page_domains d join status_pages p on p.id=d.status_page_id and p.organization_id=d.organization_id
      where d.hostname=${hostname} and p.published and d.verified_at > clock_timestamp() - interval '24 hours'
        and d.routing_verified_at > clock_timestamp() - interval '24 hours'`);
    return rows.rows[0] ?? null;
  }

  async recordHttps(domain: StatusPageDomainRecord, success: boolean) {
    const [row] = await this.db
      .update(statusPageDomains)
      .set({
        httpsVerifiedAt: success ? sql`clock_timestamp()` : null,
        httpsError: success ? null : 'HTTPS_NOT_READY',
      })
      .where(
        and(
          eq(statusPageDomains.id, domain.id),
          eq(statusPageDomains.organizationId, domain.organizationId),
          eq(statusPageDomains.checkToken, domain.checkToken!),
          sql`${statusPageDomains.verifiedAt} is not null and ${statusPageDomains.routingVerifiedAt} is not null`,
          sql`exists(select 1 from status_pages p where p.id=${statusPageDomains.statusPageId} and p.published)`,
        ),
      )
      .returning();
    return row ?? null;
  }

  /** Claim before DNS I/O, so concurrent requests cannot bypass the recheck cooldown. */
  async claimCheck(organizationId: string, statusPageId: string) {
    await this.find(organizationId, statusPageId);
    const [domain] = await this.db
      .update(statusPageDomains)
      .set({ lastCheckedAt: sql`clock_timestamp()`, checkToken: sql`gen_random_uuid()` })
      .where(
        and(
          eq(statusPageDomains.organizationId, organizationId),
          eq(statusPageDomains.statusPageId, statusPageId),
          sql`(${statusPageDomains.lastCheckedAt} is null or ${statusPageDomains.lastCheckedAt} < clock_timestamp() - interval '30 seconds')`,
        ),
      )
      .returning();
    return domain ?? null;
  }

  async recordCheck(
    domain: StatusPageDomainRecord,
    ownership: boolean,
    routing: boolean,
    error: string | null,
  ) {
    // Fence stale DNS results when a domain is removed/recreated or a later check supersedes it.
    const [updated] = await this.db
      .update(statusPageDomains)
      .set({
        verifiedAt: ownership ? sql`clock_timestamp()` : null,
        routingVerifiedAt: routing ? sql`clock_timestamp()` : null,
        lastError: error,
        httpsVerifiedAt: null,
        httpsError: null,
      })
      .where(
        and(
          eq(statusPageDomains.id, domain.id),
          eq(statusPageDomains.organizationId, domain.organizationId),
          eq(statusPageDomains.verificationToken, domain.verificationToken),
          eq(statusPageDomains.checkToken, domain.checkToken!),
        ),
      )
      .returning();
    return updated ?? null;
  }
}
