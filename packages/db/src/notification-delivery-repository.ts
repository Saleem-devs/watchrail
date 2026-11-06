import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { WatchrailDatabase } from './client.js';
import { activeMaintenancePolicyForMonitor } from './maintenance-policy.js';

export interface ClaimedNotificationDelivery {
  id: string;
  organizationId: string;
  eventId: string;
  monitorId: string;
  endpointId: string;
  endpointVersionId: string;
  endpointVersionNumber: number;
  url: string;
  signingSecretEnvelope: unknown;
  payload: unknown;
  claimToken: string;
  attemptCount: number;
  lastAttemptAt: Date;
}

export type NotificationDeliveryMaintenanceDecision = 'CONTINUE' | 'SUPPRESSED' | 'LOST_CLAIM';

export class NotificationDeliveryRepository {
  constructor(private readonly db: WatchrailDatabase) {}

  async claimNext(leaseDurationMs = 30_000): Promise<ClaimedNotificationDelivery | null> {
    positive(leaseDurationMs, 'leaseDurationMs');
    const token = randomUUID();
    const result = await this.db.execute<
      Record<string, unknown> & {
        id: string;
        organizationId: string;
        eventId: string;
        monitorId: string;
        endpointId: string;
        endpointVersionId: string;
        endpointVersionNumber: number;
        url: string;
        signingSecretEnvelope: unknown;
        payload: unknown;
        claimToken: string;
        attemptCount: number;
        lastAttemptAt: string;
      }
    >(sql`
      with candidate as (
        select delivery.id from notification_deliveries delivery
        join webhook_endpoint_versions version
          on version.organization_id=delivery.organization_id
          and version.endpoint_id=delivery.endpoint_id
          and version.id=delivery.endpoint_version_id
          and version.channel_type='WEBHOOK'
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
        from candidate where delivery.id=candidate.id
        returning delivery.*
      )
      select claimed.id, claimed.organization_id as "organizationId",
        claimed.event_id as "eventId", event.monitor_id as "monitorId",
        claimed.endpoint_id as "endpointId",
        claimed.endpoint_version_id as "endpointVersionId",
        version.version_number as "endpointVersionNumber", version.url,
        version.signing_secret_envelope as "signingSecretEnvelope", event.payload,
        claimed.claim_token as "claimToken", claimed.attempt_count as "attemptCount",
        claimed.last_attempt_at as "lastAttemptAt"
      from claimed
      join notification_events event on event.organization_id=claimed.organization_id and event.id=claimed.event_id
      join webhook_endpoint_versions version on version.organization_id=claimed.organization_id
        and version.endpoint_id=claimed.endpoint_id and version.id=claimed.endpoint_version_id
        and version.channel_type='WEBHOOK'
    `);
    const row = result.rows[0];
    if (!row) return null;
    return {
      ...row,
      lastAttemptAt: new Date(row.lastAttemptAt),
    };
  }

  async applyMaintenancePolicy(
    id: string,
    token: string,
    organizationId: string,
    monitorId: string,
  ): Promise<NotificationDeliveryMaintenanceDecision> {
    return this.db.transaction(async (tx) => {
      const claimed = await tx.execute<{ dispatchAt: string }>(sql`
        select date_trunc('milliseconds', clock_timestamp()) as "dispatchAt"
        from notification_deliveries
        where id=${id}::uuid and organization_id=${organizationId}::uuid
          and claim_token=${token}::uuid and delivered_at is null and dead_at is null
          and suppressed_at is null
        for update
      `);
      const row = claimed.rows[0];
      if (!row) return 'LOST_CLAIM';
      const policy = await activeMaintenancePolicyForMonitor(
        tx,
        organizationId,
        monitorId,
        new Date(row.dispatchAt),
      );
      if (!policy.effects.suppressNotifications) return 'CONTINUE';
      const suppressed = await tx.execute<{ id: string }>(sql`
        update notification_deliveries set
          claim_token=null,
          suppressed_at=${new Date(row.dispatchAt)},
          suppression_reason='MAINTENANCE_WINDOW',
          last_error_code=null,
          last_http_status=null
        where id=${id}::uuid and organization_id=${organizationId}::uuid
          and claim_token=${token}::uuid and delivered_at is null and dead_at is null
          and suppressed_at is null
        returning id
      `);
      return suppressed.rowCount === 1 ? 'SUPPRESSED' : 'LOST_CLAIM';
    });
  }

  async acknowledgeDelivered(id: string, token: string, httpStatus: number): Promise<boolean> {
    status(httpStatus);
    return this.finish(
      sql`update notification_deliveries set delivered_at=clock_timestamp(), claim_token=null, last_http_status=${httpStatus}, last_error_code=null where id=${id}::uuid and claim_token=${token}::uuid and delivered_at is null and dead_at is null and suppressed_at is null returning id`,
    );
  }
  async releaseForRetry(
    id: string,
    token: string,
    retryDelayMs: number,
    errorCode: string,
    httpStatus?: number,
  ): Promise<boolean> {
    positive(retryDelayMs, 'retryDelayMs');
    code(errorCode);
    if (httpStatus !== undefined) status(httpStatus);
    return this.finish(
      sql`update notification_deliveries set claim_token=null, available_at=clock_timestamp()+(${retryDelayMs}*interval '1 millisecond'), last_error_code=${errorCode}, last_http_status=${httpStatus ?? null} where id=${id}::uuid and claim_token=${token}::uuid and delivered_at is null and dead_at is null and suppressed_at is null returning id`,
    );
  }
  async markDead(
    id: string,
    token: string,
    reason: string,
    errorCode: string,
    httpStatus?: number,
  ): Promise<boolean> {
    code(reason);
    code(errorCode);
    if (httpStatus !== undefined) status(httpStatus);
    return this.finish(
      sql`update notification_deliveries set claim_token=null, dead_at=clock_timestamp(), dead_reason=${reason}, last_error_code=${errorCode}, last_http_status=${httpStatus ?? null} where id=${id}::uuid and claim_token=${token}::uuid and delivered_at is null and dead_at is null and suppressed_at is null returning id`,
    );
  }
  private async finish(query: ReturnType<typeof sql>): Promise<boolean> {
    return (await this.db.execute<{ id: string }>(query)).rowCount === 1;
  }
}
function positive(value: number, name: string) {
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new RangeError(`${name} must be a positive safe integer.`);
}
function status(value: number) {
  if (!Number.isInteger(value) || value < 100 || value > 599)
    throw new RangeError('httpStatus must be an integer from 100 to 599.');
}
function code(value: string) {
  if (!value || value.length > 64)
    throw new RangeError('Delivery reason code must contain 1 to 64 characters.');
}
