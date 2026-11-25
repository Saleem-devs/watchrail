import { resolve } from 'node:path';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { beforeAll, beforeEach, afterAll, describe, it, expect } from 'vitest';
import { eq } from 'drizzle-orm';
import { createMonitor } from '@watchrail/domain';
import { createDatabaseConnection, type DatabaseConnection } from './client.js';
import { migrateDatabase } from './migration.js';
import { MonitorRepository } from './monitor-repository.js';
import { StatusPageRepository } from './status-page-repository.js';
import { StatusPageIncidentRepository } from './status-page-incident-repository.js';
import { StatusPageSubscriptionRepository } from './status-page-subscription-repository.js';
import { decryptAuthEmail } from './auth-email-security.js';
import { incidents, statusPageSubscribers, statusPageEmailDeliveries } from './schema.js';
import { ManualRoundRepository } from './manual-round-repository.js';
import { MaintenanceWindowRepository } from './maintenance-window-repository.js';

const org = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const otherOrg = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const actor = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const keyring = { activeKeyId: 'test', keys: new Map([['test', Buffer.alloc(32, 9)]]) };

describe('status-page subscriber delivery', () => {
  let container: StartedPostgreSqlContainer;
  let connection: DatabaseConnection;
  let subscriptions: StatusPageSubscriptionRepository;
  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:18.0-alpine').start();
    connection = createDatabaseConnection(container.getConnectionUri());
    await migrateDatabase(connection, resolve(process.cwd(), 'drizzle'));
    subscriptions = new StatusPageSubscriptionRepository(connection.db);
  }, 60_000);
  afterAll(async () => {
    await connection?.pool.end();
    await container?.stop();
  });
  beforeEach(async () => {
    await connection.pool.query(
      'truncate status_pages, monitors, status_page_subscription_limits cascade',
    );
  });

  async function page(slug = 'acme-status', organizationId = org) {
    const monitor = await new MonitorRepository(connection.db).create(
      organizationId,
      createMonitor({ name: 'Private endpoint', url: 'https://private.example.test' }),
    );
    return new StatusPageRepository(connection.db).create(organizationId, {
      name: 'Public status',
      slug,
      published: true,
      components: [{ displayName: 'Public API', monitorId: monitor.id, position: 0 }],
    });
  }
  async function subscribe(slug: string, email = 'visitor@example.com') {
    await subscriptions.request(slug, email, keyring);
    const [row] = await connection.db
      .select()
      .from(statusPageSubscribers)
      .orderBy(statusPageSubscribers.requestedAt);
    const deliveries = await connection.db
      .select()
      .from(statusPageEmailDeliveries)
      .where(eq(statusPageEmailDeliveries.subscriberId, row!.id));
    const delivery = deliveries.find(
      (d) => d.generation === row!.generation && d.kind === 'VERIFY',
    )!;
    const payload = decryptAuthEmail(
      delivery.encryptedPayload,
      `status-verification:${delivery.id}`,
      keyring,
    ) as { verification: string };
    const details = decryptAuthEmail(
      row!.encryptedDetails,
      `subscriber:${row!.id}:${row!.generation}`,
      keyring,
    ) as { email: string; unsubscribe: string };
    return { row: row!, delivery, verification: payload.verification, ...details };
  }
  async function open(p: Awaited<ReturnType<typeof page>>) {
    return new StatusPageIncidentRepository(connection.db).create(org, p.id, actor, {
      title: 'API degraded',
      impact: 'DEGRADED',
      message: 'We are investigating.',
      componentIds: [p.components[0]!.id],
    });
  }
  async function expand() {
    while (await subscriptions.expandNext()) {
      /* drain */
    }
  }
  async function events() {
    return (
      await connection.pool.query<{ subject: string; body: string }>(
        'select * from status_page_email_events order by created_at, id',
      )
    ).rows;
  }
  async function deliveries() {
    return connection.db.select().from(statusPageEmailDeliveries);
  }

  it('rejects mailbox aliases expressed as display names, comments or lists before storing or limiting', async () => {
    const p = await page();
    for (const email of [
      'Alice<victim@example.com>',
      'Bob<victim@example.com>',
      '<victim@example.com>',
      'victim@example.com(test)',
      'a@example.com,b@example.com',
    ]) {
      await expect(subscriptions.request(p.slug, email, keyring)).rejects.toThrow(
        'Invalid subscription mailbox',
      );
    }
    expect(await connection.db.select().from(statusPageSubscribers)).toHaveLength(0);
    expect(
      (await connection.pool.query('select * from status_page_subscription_limits')).rows,
    ).toHaveLength(0);
    await subscribe(p.slug, ' Visitor@Example.COM ');
    await subscriptions.request(p.slug, 'visitor@example.com', keyring);
    expect(await connection.db.select().from(statusPageSubscribers)).toHaveLength(1);
    expect(await deliveries()).toHaveLength(1);
  });

  it.each(['manual', 'monitor', 'maintenance'])(
    'serializes concurrent %s capture with unpublication without replay',
    async (kind) => {
      const p = await page();
      const sub = await subscribe(p.slug);
      await subscriptions.confirm(sub.verification);
      const incident = await open(p);
      const round = await new ManualRoundRepository(connection.db).create(
        org,
        p.components[0]!.monitorId,
      );
      const maintenance = await new MaintenanceWindowRepository(connection.db).create(
        org,
        p.projectId!,
        actor,
        {
          name: 'Race maintenance',
          schedule: {
            type: 'ONE_TIME',
            startsAt: '2030-01-01T00:00:00Z',
            endsAt: '2030-01-01T01:00:00Z',
          },
          target: { type: 'PROJECT' },
          effects: {
            suppressNotifications: true,
            suppressIncidentCreation: true,
            excludeFromUptime: true,
            publishToStatusPage: true,
          },
        },
      );
      const a = await connection.pool.connect();
      const b = await connection.pool.connect();
      let pending: Promise<unknown> | undefined;
      try {
        await a.query('begin');
        await a.query('update status_pages set published=false where id=$1', [p.id]);
        const pid = (await b.query<{ pid: number }>('select pg_backend_pid() as pid')).rows[0]!.pid;
        pending =
          kind === 'manual'
            ? b.query(
                `insert into status_page_incident_updates (organization_id, incident_id, sequence, state, message, created_by_actor_id)
        values ($1,$2,2,'INVESTIGATING','Concurrent update',$3)`,
                [org, incident.id, actor],
              )
            : kind === 'monitor'
              ? b.query(
                  `insert into incidents (organization_id, monitor_id, started_by_round_id, opened_by_round_id, started_at, opened_at, group_key, severity)
          values ($1,$2,$3,$3,now(),now(),'race','DOWN')`,
                  [org, round.monitorId, round.id],
                )
              : b.query(
                  `insert into maintenance_window_audit_events (organization_id, project_id, maintenance_window_id, action, version_number, actor_id)
          values ($1,$2,$3,'UPDATED',1,$4)`,
                  [org, p.projectId, maintenance.id, actor],
                );
        // Observe the actual PostgreSQL lock wait instead of assuming a timing delay.
        await expect
          .poll(
            async () =>
              (
                await connection.pool.query<{ blocked: boolean }>(
                  'select cardinality(pg_blocking_pids($1)) > 0 as blocked',
                  [pid],
                )
              ).rows[0]!.blocked,
          )
          .toBe(true);
        await a.query('commit');
        await pending;
        await connection.pool.query('update status_pages set published=true where id=$1', [p.id]);
        await expand();
        expect(await events()).toHaveLength(2);
        expect((await deliveries()).filter((d) => d.kind === 'EVENT')).toHaveLength(0);
      } finally {
        await a.query('rollback');
        await pending?.catch(() => undefined);
        a.release();
        b.release();
      }
    },
  );

  it('includes weekdays and date bounds in recurring maintenance updates', async () => {
    const p = await page();
    const windows = new MaintenanceWindowRepository(connection.db);
    const input = {
      name: 'Weekly maintenance',
      schedule: {
        type: 'RECURRING',
        timezone: 'UTC',
        localTime: '20:00',
        daysOfWeek: [1],
        durationMinutes: 60,
        startsOn: '2030-01-01',
        endsOn: '2030-06-01',
      },
      target: { type: 'PROJECT' },
      effects: {
        suppressNotifications: true,
        suppressIncidentCreation: true,
        excludeFromUptime: true,
        publishToStatusPage: true,
      },
    };
    const window = await windows.create(org, p.projectId!, actor, input);
    await windows.update(org, p.projectId!, window.id, actor, {
      ...input,
      schedule: {
        ...input.schedule,
        daysOfWeek: [5],
        startsOn: '2030-02-01',
        endsOn: '2030-07-01',
      },
    });
    const captured = await events();
    expect(captured[0]!.body).toContain('Monday');
    expect(captured[0]!.body).toContain('2030-01-01');
    expect(captured[0]!.body).toContain('2030-06-01');
    expect(captured[1]!.body).toContain('Friday');
    expect(captured[1]!.body).toContain('2030-02-01');
    expect(captured[1]!.body).toContain('2030-07-01');
  });

  it('requires verification, encrypts address and tokens, and never backfills pre-verification events', async () => {
    const p = await page();
    const sub = await subscribe(p.slug, 'Visitor@Example.com');
    expect(sub.email).toBe('visitor@example.com');
    expect(JSON.stringify(sub.row)).not.toContain('visitor@example.com');
    expect(JSON.stringify(sub.row)).not.toContain(sub.verification);
    await open(p);
    expect(await subscriptions.confirm(sub.verification)).toBe(true);
    expect(await subscriptions.confirm(sub.verification)).toBe(true);
    await expand();
    expect((await deliveries()).filter((d) => d.kind === 'EVENT')).toHaveLength(0);
    const incident = await open(p);
    await new StatusPageIncidentRepository(connection.db).appendUpdate(
      org,
      p.id,
      incident.id,
      actor,
      { state: 'RESOLVED', message: 'Resolved communication.' },
    );
    await expand();
    await expand();
    expect((await deliveries()).filter((d) => d.kind === 'EVENT')).toHaveLength(2);
  });

  it('suppresses queued and claimed mail on unsubscribe, and old confirmation cannot reactivate it', async () => {
    const p = await page();
    const sub = await subscribe(p.slug);
    await subscriptions.confirm(sub.verification);
    await open(p);
    await expand();
    await connection.pool.query(
      "update status_page_email_deliveries set state='SUPPRESSED' where kind='VERIFY'",
    );
    const claim = (await subscriptions.claimNext(30_000))!;
    expect(await subscriptions.authorize(claim.id, claim.token)).not.toBeNull();
    await subscriptions.unsubscribe(sub.unsubscribe);
    expect(await subscriptions.authorize(claim.id, claim.token)).toBeNull();
    expect(await subscriptions.finish(claim.id, claim.token, 'DELIVERED')).toBe(false);
    expect(await subscriptions.confirm(sub.verification)).toBe(false);
    await subscriptions.unsubscribe(sub.unsubscribe);
  });

  it('rejects expired confirmations and invalid tokens; concurrent requests produce one verification delivery', async () => {
    const p = await page();
    await Promise.all([
      subscriptions.request(p.slug, 'visitor@example.com', keyring),
      subscriptions.request(p.slug, 'visitor@example.com', keyring),
    ]);
    const sub = await subscribe(p.slug);
    expect(await deliveries()).toHaveLength(1);
    await connection.pool.query(
      "update status_page_subscribers set expires_at=clock_timestamp()-interval '1 second'",
    );
    expect(await subscriptions.confirm(sub.verification)).toBe(false);
    expect(await subscriptions.confirm('invalid')).toBe(false);
    expect(
      await subscriptions.authorize(sub.delivery.id, '00000000-0000-4000-8000-000000000000'),
    ).toBeNull();
  });

  it('fences stale lease acknowledgments after reclaim', async () => {
    const p = await page();
    await subscribe(p.slug);
    const first = (await subscriptions.claimNext(30_000))!;
    await connection.pool.query(
      "update status_page_email_deliveries set lease_expires_at=clock_timestamp()-interval '1 second'",
    );
    const second = (await subscriptions.claimNext(30_000))!;
    expect(second.id).toBe(first.id);
    expect(second.token).not.toBe(first.token);
    expect(await subscriptions.finish(first.id, first.token, 'DELIVERED')).toBe(false);
    expect(await subscriptions.finish(second.id, second.token, 'DELIVERED')).toBe(true);
  });

  it('keeps subscriptions page-scoped and does not publish hidden-page events', async () => {
    const p = await page();
    const foreign = await page('other-page', otherOrg);
    const sub = await subscribe(p.slug);
    await subscriptions.confirm(sub.verification);
    await new StatusPageIncidentRepository(connection.db).create(otherOrg, foreign.id, actor, {
      title: 'Foreign',
      impact: 'DOWN',
      message: 'Private tenant',
      componentIds: [foreign.components[0]!.id],
    });
    await expand();
    expect((await deliveries()).filter((d) => d.kind === 'EVENT')).toHaveLength(0);
    await connection.pool.query('update status_pages set published=false where id=$1', [p.id]);
    await open(p);
    expect(await events()).toHaveLength(1);
    expect((await deliveries())[0]!.state).toBe('SUPPRESSED');
    await subscriptions.request('missing-page', 'new@example.com', keyring);
    expect(await connection.db.select().from(statusPageSubscribers)).toHaveLength(1);
  });

  it('captures monitor transitions with public names and honest operator-resolution wording', async () => {
    const p = await page();
    const round = await new ManualRoundRepository(connection.db).create(
      org,
      p.components[0]!.monitorId,
    );
    const [incident] = await connection.db
      .insert(incidents)
      .values({
        organizationId: org,
        monitorId: round.monitorId,
        startedByRoundId: round.id,
        openedByRoundId: round.id,
        startedAt: new Date(),
        openedAt: new Date(),
        groupKey: 'test',
        severity: 'DOWN',
      })
      .returning();
    await connection.db
      .update(incidents)
      .set({ status: 'RESOLVED', resolvedAt: new Date(), resolvedByActorId: actor })
      .where(eq(incidents.id, incident!.id));
    const captured = await events();
    expect(captured).toHaveLength(2);
    expect(captured[0]!.subject).toContain('Public API');
    expect(captured[1]!.body).toContain('does not establish service recovery');
    expect(JSON.stringify(captured)).not.toContain('private.example.test');
    expect(JSON.stringify(captured)).not.toContain('Private endpoint');
  });

  it('publishes only public maintenance schedules, edits and cancellations', async () => {
    const p = await page();
    const windows = new MaintenanceWindowRepository(connection.db);
    const input = {
      name: 'Database upgrade',
      schedule: {
        type: 'ONE_TIME',
        startsAt: new Date(Date.now() + 60_000).toISOString(),
        endsAt: new Date(Date.now() + 3600_000).toISOString(),
      },
      target: { type: 'MONITORS', monitorIds: [p.components[0]!.monitorId] },
      effects: {
        suppressNotifications: true,
        suppressIncidentCreation: true,
        excludeFromUptime: true,
        publishToStatusPage: true,
      },
    };
    const window = await windows.create(org, p.projectId!, actor, input);
    await windows.update(org, p.projectId!, window.id, actor, {
      ...input,
      name: 'Updated upgrade',
    });
    await windows.archive(org, p.projectId!, window.id, actor);
    expect((await events()).map((e) => e.subject)).toEqual([
      'Maintenance scheduled — Database upgrade',
      'Maintenance updated — Updated upgrade',
      'Maintenance cancelled — Updated upgrade',
    ]);
    await windows.create(org, p.projectId!, actor, {
      ...input,
      effects: { ...input.effects, publishToStatusPage: false },
    });
    expect(await events()).toHaveLength(3);
  });

  it('rolls back the source publication if event insertion fails', async () => {
    const p = await page();
    await connection.pool
      .query(`create function fail_status_email() returns trigger language plpgsql as $$ begin raise exception 'failure'; end $$;
      create trigger fail_status_email before insert on status_page_email_events for each row execute function fail_status_email();`);
    try {
      await expect(open(p)).rejects.toThrow();
    } finally {
      await connection.pool.query(
        'drop trigger fail_status_email on status_page_email_events; drop function fail_status_email();',
      );
    }
    expect((await connection.pool.query('select * from status_page_incidents')).rows).toHaveLength(
      0,
    );
  });

  it('enforces shared rate limits atomically', async () => {
    const result = await Promise.all(
      Array.from({ length: 10 }, () => subscriptions.consumeLimit('ip:test', 3)),
    );
    expect(result.filter(Boolean)).toHaveLength(3);
    expect(
      JSON.stringify(
        (await connection.pool.query('select * from status_page_subscription_limits')).rows,
      ),
    ).not.toContain('ip:test');
  });

  it('invalidates previous tokens on resend and does not revive old deliveries after resubscription', async () => {
    const p = await page();
    const first = await subscribe(p.slug);
    await connection.pool.query(
      "update status_page_subscribers set requested_at=clock_timestamp()-interval '2 minutes'",
    );
    const second = await subscribe(p.slug);
    expect(second.row.generation).not.toBe(first.row.generation);
    expect(await subscriptions.confirm(first.verification)).toBe(false);
    expect(await subscriptions.confirm(second.verification)).toBe(true);
    await open(p);
    await expand();
    await subscriptions.unsubscribe(second.unsubscribe);
    await connection.pool.query(
      "update status_page_subscribers set requested_at=clock_timestamp()-interval '2 minutes'",
    );
    const third = await subscribe(p.slug);
    expect(await subscriptions.confirm(third.verification)).toBe(true);
    await subscriptions.unsubscribe(second.unsubscribe);
    const [current] = await connection.db.select().from(statusPageSubscribers);
    expect(current!.state).toBe('ACTIVE');
    expect(
      (await deliveries()).filter((d) => d.kind === 'EVENT').every((d) => d.state === 'SUPPRESSED'),
    ).toBe(true);
  });

  it('does not replay pending events after a page is unpublished and republished', async () => {
    const p = await page();
    const sub = await subscribe(p.slug);
    await subscriptions.confirm(sub.verification);
    await open(p);
    await connection.pool.query('update status_pages set published=false where id=$1', [p.id]);
    await connection.pool.query('update status_pages set published=true where id=$1', [p.id]);
    await expand();
    expect((await deliveries()).filter((d) => d.kind === 'EVENT')).toHaveLength(0);
  });

  it('notifies withdrawal without exposing a new private maintenance name', async () => {
    const p = await page();
    const windows = new MaintenanceWindowRepository(connection.db);
    const input = {
      name: 'Public upgrade',
      schedule: {
        type: 'ONE_TIME',
        startsAt: new Date(Date.now() + 60_000).toISOString(),
        endsAt: new Date(Date.now() + 3600_000).toISOString(),
      },
      target: { type: 'PROJECT' },
      effects: {
        suppressNotifications: true,
        suppressIncidentCreation: true,
        excludeFromUptime: true,
        publishToStatusPage: true,
      },
    };
    const window = await windows.create(org, p.projectId!, actor, input);
    await windows.update(org, p.projectId!, window.id, actor, {
      ...input,
      name: 'Secret maintenance details',
      effects: { ...input.effects, publishToStatusPage: false },
    });
    const captured = await events();
    expect(captured).toHaveLength(2);
    expect(captured[1]!.subject).toBe('Maintenance publication withdrawn — Public upgrade');
    expect(JSON.stringify(captured)).not.toContain('Secret maintenance details');
  });
});
