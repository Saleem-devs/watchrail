import { resolve } from 'node:path';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { beforeAll, afterAll, beforeEach, describe, it, expect } from 'vitest';
import { createMonitor } from '@watchrail/domain';
import { createDatabaseConnection, type DatabaseConnection } from './client.js';
import { migrateDatabase } from './migration.js';
import { MonitorRepository } from './monitor-repository.js';
import { StatusPageRepository } from './status-page-repository.js';
import {
  normalizeStatusHostname,
  StatusPageDomainRepository,
} from './status-page-domain-repository.js';

const org = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const foreign = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
describe('status page domain ownership', () => {
  let container: StartedPostgreSqlContainer;
  let connection: DatabaseConnection;
  let domains: StatusPageDomainRepository;
  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:18.0-alpine').start();
    connection = createDatabaseConnection(container.getConnectionUri());
    await migrateDatabase(connection, resolve(process.cwd(), 'drizzle'));
    domains = new StatusPageDomainRepository(connection.db);
  }, 60_000);
  afterAll(async () => {
    await connection?.pool.end();
    await container?.stop();
  });
  beforeEach(async () => {
    await connection.pool.query('truncate status_pages, monitors cascade');
  });
  async function page(slug: string, organizationId = org) {
    const monitor = await new MonitorRepository(connection.db).create(
      organizationId,
      createMonitor({ name: 'API', url: 'https://example.com' }),
    );
    return new StatusPageRepository(connection.db).create(organizationId, {
      name: slug,
      slug,
      published: true,
      components: [{ displayName: 'API', monitorId: monitor.id, position: 0 }],
    });
  }
  it('accepts canonical DNS names and rejects URLs, ports, wildcard, IP and private names', () => {
    expect(normalizeStatusHostname(' Status.Example.com ')).toBe('status.example.com');
    for (const host of [
      'example.com',
      'example.co.uk',
      'github.io',
      'https://status.example.com',
      '*.example.com',
      'status.example.com:443',
      'status.example.com/path',
      '127.0.0.1',
      '[::1]',
      'localhost',
      'service.internal',
      'a..com',
      'a.com.',
      'a.com@evil.com',
    ])
      expect(normalizeStatusHostname(host)).toBeNull();
  });
  it('isolates claims by tenant and rejects globally duplicated hostnames', async () => {
    const a = await page('one');
    const b = await page('two', foreign);
    const claim = await domains.attach(org, a.id, 'status.example.com');
    expect(claim.verifiedAt).toBeNull();
    expect((await domains.attach(org, a.id, 'STATUS.EXAMPLE.COM')).verificationToken).toBe(
      claim.verificationToken,
    );
    await expect(domains.attach(foreign, b.id, 'status.example.com')).rejects.toThrow(
      'already assigned',
    );
    await expect(domains.find(foreign, a.id)).rejects.toThrow('not found');
    await expect(domains.remove(foreign, a.id)).rejects.toThrow('not found');
    expect(await domains.find(org, a.id)).not.toBeNull();
  });
  it('claims verification atomically and fences deleted/recreated domain results', async () => {
    const p = await page('one');
    await domains.attach(org, p.id, 'status.example.com');
    const attempts = await Promise.all([
      domains.claimCheck(org, p.id),
      domains.claimCheck(org, p.id),
    ]);
    expect(attempts.filter(Boolean)).toHaveLength(1);
    const attempt = attempts.find(Boolean)!;
    const verified = await domains.recordCheck(attempt, true, true, null);
    expect(verified?.verifiedAt).toBeInstanceOf(Date);
    expect(verified?.routingVerifiedAt).toBeInstanceOf(Date);
    await domains.remove(org, p.id);
    const replacement = await domains.attach(org, p.id, 'status.example.com');
    expect(replacement.verificationToken).not.toBe(attempt.verificationToken);
    expect(await domains.recordCheck(attempt, true, true, null)).toBeNull();
    expect((await domains.find(org, p.id))?.verifiedAt).toBeNull();
  });
  it('invalidates stale ownership and routing on failed re-verification', async () => {
    const p = await page('one');
    await domains.attach(org, p.id, 'status.example.com');
    const attempt = (await domains.claimCheck(org, p.id))!;
    await domains.recordCheck(attempt, true, true, null);
    await connection.pool.query(
      "update status_page_domains set last_checked_at=now()-interval '1 minute'",
    );
    const next = (await domains.claimCheck(org, p.id))!;
    expect(await domains.recordCheck(attempt, true, true, null)).toBeNull();
    await domains.recordCheck(next, false, false, 'OWNERSHIP_NOT_VERIFIED');
    const current = await domains.find(org, p.id);
    expect(current?.verifiedAt).toBeNull();
    expect(current?.routingVerifiedAt).toBeNull();
  });
  it('requires fresh DNS for issuance and fresh HTTPS for Ready; unpublication fences in-flight checks', async () => {
    const p = await page('eligible');
    await domains.attach(org, p.id, 'status.example.com');
    expect(await domains.resolve('status.example.com')).toBeNull();
    expect(await domains.eligibleHostnames()).toEqual([]);
    const claim = (await domains.claimCheck(org, p.id))!;
    const checked = (await domains.recordCheck(claim, true, true, null))!;
    expect(await domains.eligibleHostnames()).toEqual(['status.example.com']);
    expect(await domains.resolve(checked.hostname)).toMatchObject({
      pageId: p.id,
      httpsReady: false,
    });
    await domains.recordHttps(checked, true);
    expect(await domains.resolve(checked.hostname)).toMatchObject({ httpsReady: true });
    await connection.pool.query('update status_pages set published=false where id=$1', [p.id]);
    expect(await domains.resolve(checked.hostname)).toBeNull();
    expect(await domains.eligibleHostnames()).toEqual([]);
    expect(await domains.recordHttps(checked, true)).toBeNull();
    expect(await domains.recordCheck(claim, true, true, null)).toBeNull();
    await connection.pool.query('update status_pages set published=true where id=$1', [p.id]);
    expect(await domains.resolve(checked.hostname)).toMatchObject({ httpsReady: false });
    expect(await domains.recordHttps(checked, true)).toBeNull();
    const fresh = (await domains.claimCheck(org, p.id))!;
    const dns = (await domains.recordCheck(fresh, true, true, null))!;
    await domains.recordHttps(dns, true);
    expect(await domains.resolve(checked.hostname)).toMatchObject({ httpsReady: true });
    await connection.pool.query(
      "update status_page_domains set verified_at=now()-interval '25 hours'",
    );
    expect(await domains.resolve(checked.hostname)).toBeNull();
    expect(await domains.eligibleHostnames()).toEqual([]);
    await domains.remove(org, p.id);
    expect(await domains.recordHttps(dns, true)).toBeNull();
  });
  it('keeps failed DNS checks eligible for background retries', async () => {
    const p = await page('retry');
    await domains.attach(org, p.id, 'status.example.com');
    const attempt = (await domains.claimCheck(org, p.id))!;
    await domains.recordCheck(attempt, false, false, 'OWNERSHIP_NOT_VERIFIED');
    await connection.pool.query(
      "update status_page_domains set last_checked_at=now()-interval '6 minutes'",
    );
    expect(await domains.dueChecks()).toEqual([{ organizationId: org, statusPageId: p.id }]);
  });
});
