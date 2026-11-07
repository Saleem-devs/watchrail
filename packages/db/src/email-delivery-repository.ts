import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { EmailNotificationV1 } from '@watchrail/contracts';
import type { WatchrailDatabase } from './client.js';
import {
  suppressClaimedDeliveryForIncidentSilence,
  suppressClaimedReminderForClosedIncident,
} from './incident-notification-policy.js';
import { activeMaintenancePolicyForMonitor } from './maintenance-policy.js';

export interface ClaimedEmailNotificationDelivery {
  id: string;
  organizationId: string;
  eventId: string;
  monitorId: string | null;
  channelId: string;
  channelVersionId: string;
  deliverySequence: number;
  recipientEmails: string[];
  payload: EmailNotificationV1;
  claimToken: string;
  attemptCount: number;
}

export type EmailDeliveryDispatchDecision =
  | { state: 'CONTINUE'; databaseNow: Date; leaseExpiresAt: Date }
  | { state: 'SUPPRESSED' | 'LOST_CLAIM' };

export class EmailDeliveryRepository {
  constructor(private readonly db: WatchrailDatabase) {}

  async claimNext(leaseDurationMs = 30_000): Promise<ClaimedEmailNotificationDelivery | null> {
    positive(leaseDurationMs, 'leaseDurationMs');
    const token = randomUUID();
    const result = await this.db.execute<{
      id: string;
      organizationId: string;
      eventId: string;
      monitorId: string | null;
      channelId: string;
      channelVersionId: string;
      deliverySequence: number;
      recipientEmails: string[];
      payload: EmailNotificationV1;
      claimToken: string;
      attemptCount: number;
    }>(sql`
      with candidate as (
        select delivery.id from notification_deliveries delivery
        join webhook_endpoint_versions version
          on version.organization_id=delivery.organization_id
          and version.endpoint_id=delivery.endpoint_id
          and version.id=delivery.endpoint_version_id
          and version.channel_type='EMAIL'
        where delivery.delivered_at is null and delivery.dead_at is null
          and delivery.suppressed_at is null and delivery.available_at <= clock_timestamp()
        order by delivery.available_at, delivery.created_at, delivery.id
        for update of delivery skip locked limit 1
      ), claimed as (
        update notification_deliveries delivery set
          claim_token=${token}::uuid,
          available_at=clock_timestamp() + (${leaseDurationMs} * interval '1 millisecond'),
          attempt_count=delivery.attempt_count + 1,
          last_attempt_at=clock_timestamp()
        from candidate where delivery.id=candidate.id returning delivery.*
      )
      select claimed.id, claimed.organization_id as "organizationId",
        claimed.event_id as "eventId", event.monitor_id as "monitorId",
        claimed.endpoint_id as "channelId",
        claimed.endpoint_version_id as "channelVersionId",
        claimed.delivery_sequence as "deliverySequence",
        version.recipient_emails as "recipientEmails", event.payload,
        claimed.claim_token as "claimToken", claimed.attempt_count as "attemptCount"
      from claimed
      join notification_events event on event.organization_id=claimed.organization_id
        and event.id=claimed.event_id
      join webhook_endpoint_versions version on version.organization_id=claimed.organization_id
        and version.endpoint_id=claimed.endpoint_id and version.id=claimed.endpoint_version_id
        and version.channel_type='EMAIL'
    `);
    return result.rows[0] ?? null;
  }

  async applyMaintenancePolicy(
    id: string,
    token: string,
    organizationId: string,
    monitorId: string | null,
  ): Promise<EmailDeliveryDispatchDecision> {
    return this.db.transaction(async (tx) => {
      const claimed = await tx.execute<{ policyAt: Date | string }>(sql`
        select date_trunc('milliseconds', clock_timestamp()) as "policyAt"
        from notification_deliveries
        where id=${id}::uuid and organization_id=${organizationId}::uuid
          and claim_token=${token}::uuid and delivered_at is null and dead_at is null
          and suppressed_at is null for update
      `);
      const row = claimed.rows[0];
      if (!row) return { state: 'LOST_CLAIM' };
      const policyAt = new Date(row.policyAt);
      if (
        await suppressClaimedReminderForClosedIncident(tx, {
          deliveryId: id,
          claimToken: token,
          organizationId,
          policyAt,
        })
      ) {
        return { state: 'SUPPRESSED' };
      }
      if (
        await suppressClaimedDeliveryForIncidentSilence(tx, {
          deliveryId: id,
          claimToken: token,
          organizationId,
          policyAt,
        })
      ) {
        return { state: 'SUPPRESSED' };
      }
      if (monitorId) {
        const policy = await activeMaintenancePolicyForMonitor(
          tx,
          organizationId,
          monitorId,
          policyAt,
        );
        if (policy.effects.suppressNotifications) {
          const result = await tx.execute<{ id: string }>(sql`
            update notification_deliveries set claim_token=null,
              suppressed_at=clock_timestamp(), suppression_reason='MAINTENANCE_WINDOW',
              last_error_code=null, last_http_status=null
            where id=${id}::uuid and organization_id=${organizationId}::uuid
              and claim_token=${token}::uuid and delivered_at is null and dead_at is null
              and suppressed_at is null returning id
          `);
          return { state: result.rowCount === 1 ? 'SUPPRESSED' : 'LOST_CLAIM' };
        }
      }
      const lease = await tx.execute<{
        databaseNow: Date | string;
        leaseExpiresAt: Date | string;
      }>(sql`
        select date_trunc('milliseconds', clock_timestamp()) as "databaseNow",
          available_at as "leaseExpiresAt"
        from notification_deliveries
        where id=${id}::uuid and organization_id=${organizationId}::uuid
          and claim_token=${token}::uuid and delivered_at is null and dead_at is null
          and suppressed_at is null
      `);
      const current = lease.rows[0];
      return current
        ? {
            state: 'CONTINUE',
            databaseNow: new Date(current.databaseNow),
            leaseExpiresAt: new Date(current.leaseExpiresAt),
          }
        : { state: 'LOST_CLAIM' };
    });
  }

  acknowledgeDelivered(id: string, token: string): Promise<boolean> {
    return this.finish(sql`
      update notification_deliveries set delivered_at=clock_timestamp(), claim_token=null,
        last_error_code=null, last_http_status=null
      where id=${id}::uuid and claim_token=${token}::uuid and delivered_at is null
        and dead_at is null and suppressed_at is null returning id
    `);
  }

  releaseForRetry(
    id: string,
    token: string,
    retryDelayMs: number,
    errorCode: string,
  ): Promise<boolean> {
    positive(retryDelayMs, 'retryDelayMs');
    code(errorCode);
    return this.finish(sql`
      update notification_deliveries set claim_token=null,
        available_at=clock_timestamp()+(${retryDelayMs}*interval '1 millisecond'),
        last_error_code=${errorCode}, last_http_status=null
      where id=${id}::uuid and claim_token=${token}::uuid and delivered_at is null
        and dead_at is null and suppressed_at is null returning id
    `);
  }

  markDead(id: string, token: string, reason: string, errorCode: string): Promise<boolean> {
    code(reason);
    code(errorCode);
    return this.finish(sql`
      update notification_deliveries set dead_at=clock_timestamp(), dead_reason=${reason},
        claim_token=null, last_error_code=${errorCode}, last_http_status=null
      where id=${id}::uuid and claim_token=${token}::uuid and delivered_at is null
        and dead_at is null and suppressed_at is null returning id
    `);
  }

  private async finish(query: ReturnType<typeof sql>): Promise<boolean> {
    const result = await this.db.execute<{ id: string }>(query);
    return result.rowCount === 1;
  }
}

function positive(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be positive.`);
}

function code(value: string): void {
  if (!/^[A-Z0-9_]{1,64}$/u.test(value)) throw new Error('Delivery code is invalid.');
}
