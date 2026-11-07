import { and, desc, eq, sql } from 'drizzle-orm';
import type { WatchrailDatabase } from './client.js';
import { notificationDeliveries, notificationEvents, webhookEndpoints } from './schema.js';
import type { WebhookDeliveryStatus } from './webhook-delivery-read-repository.js';

export interface SlackDeliveryListItem {
  id: string;
  event: {
    id: string;
    type: 'INCIDENT_OPENED' | 'INCIDENT_RESOLVED' | 'TEST';
    occurredAt: Date;
    monitorId: string | null;
    incidentId: string | null;
  };
  status: WebhookDeliveryStatus;
  attemptCount: number;
  lastAttemptAt: Date | null;
  lastErrorCode: string | null;
  lastHttpStatus: number | null;
  nextAttemptAt: Date | null;
  leaseExpiresAt: Date | null;
  deliveredAt: Date | null;
  deadAt: Date | null;
  deadReason: string | null;
  suppressedAt: Date | null;
  suppressionReason: string | null;
  createdAt: Date;
}

export class SlackDeliveryReadRepository {
  constructor(private readonly db: WatchrailDatabase) {}

  async listForChannel(
    organizationId: string,
    channelId: string,
    limit = 25,
  ): Promise<SlackDeliveryListItem[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
      throw new Error('Slack delivery history limit must be an integer from 1 to 100.');
    const cutoffResult = await this.db.execute<{ cutoff: Date | string }>(sql`
      select clock_timestamp() as cutoff from webhook_endpoints
      where organization_id=${organizationId}::uuid and id=${channelId}::uuid
        and channel_type='SLACK' and archived_at is null limit 1
    `);
    const cutoffValue = cutoffResult.rows[0]?.cutoff;
    if (!cutoffValue) throw new SlackDeliveryChannelNotFoundError();
    const cutoff = cutoffValue instanceof Date ? cutoffValue : new Date(cutoffValue);
    const rows = await this.db
      .select({
        id: notificationDeliveries.id,
        availableAt: notificationDeliveries.availableAt,
        claimToken: notificationDeliveries.claimToken,
        attemptCount: notificationDeliveries.attemptCount,
        lastAttemptAt: notificationDeliveries.lastAttemptAt,
        lastErrorCode: notificationDeliveries.lastErrorCode,
        lastHttpStatus: notificationDeliveries.lastHttpStatus,
        deliveredAt: notificationDeliveries.deliveredAt,
        deadAt: notificationDeliveries.deadAt,
        deadReason: notificationDeliveries.deadReason,
        suppressedAt: notificationDeliveries.suppressedAt,
        suppressionReason: notificationDeliveries.suppressionReason,
        createdAt: notificationDeliveries.createdAt,
        eventId: notificationEvents.id,
        eventType: notificationEvents.eventType,
        occurredAt: notificationEvents.occurredAt,
        monitorId: notificationEvents.monitorId,
        incidentId: notificationEvents.incidentId,
      })
      .from(notificationDeliveries)
      .innerJoin(
        notificationEvents,
        and(
          eq(notificationEvents.organizationId, notificationDeliveries.organizationId),
          eq(notificationEvents.id, notificationDeliveries.eventId),
        ),
      )
      .innerJoin(
        webhookEndpoints,
        and(
          eq(webhookEndpoints.organizationId, notificationDeliveries.organizationId),
          eq(webhookEndpoints.id, notificationDeliveries.endpointId),
          eq(webhookEndpoints.channelType, 'SLACK'),
        ),
      )
      .where(
        and(
          eq(notificationDeliveries.organizationId, organizationId),
          eq(notificationDeliveries.endpointId, channelId),
        ),
      )
      .orderBy(desc(notificationDeliveries.createdAt), desc(notificationDeliveries.id))
      .limit(limit);
    return rows.map((row) => {
      const status = deriveStatus(row, cutoff);
      return {
        id: row.id,
        event: {
          id: row.eventId,
          type: row.eventType,
          occurredAt: row.occurredAt,
          monitorId: row.monitorId,
          incidentId: row.incidentId,
        },
        status,
        attemptCount: row.attemptCount,
        lastAttemptAt: row.lastAttemptAt,
        lastErrorCode: row.lastErrorCode,
        lastHttpStatus: row.lastHttpStatus,
        nextAttemptAt: status === 'RETRY_SCHEDULED' ? row.availableAt : null,
        leaseExpiresAt: status === 'IN_FLIGHT' ? row.availableAt : null,
        deliveredAt: row.deliveredAt,
        deadAt: row.deadAt,
        deadReason: row.deadReason,
        suppressedAt: row.suppressedAt,
        suppressionReason: row.suppressionReason,
        createdAt: row.createdAt,
      };
    });
  }
}

function deriveStatus(
  row: {
    deliveredAt: Date | null;
    deadAt: Date | null;
    suppressedAt: Date | null;
    claimToken: string | null;
    attemptCount: number;
    availableAt: Date;
  },
  cutoff: Date,
): WebhookDeliveryStatus {
  if (row.deliveredAt) return 'DELIVERED';
  if (row.suppressedAt) return 'SUPPRESSED';
  if (row.deadAt) return 'DEAD';
  if (row.claimToken && row.availableAt > cutoff) return 'IN_FLIGHT';
  if (!row.claimToken && row.attemptCount > 0 && row.availableAt > cutoff) return 'RETRY_SCHEDULED';
  return 'PENDING';
}

export class SlackDeliveryChannelNotFoundError extends Error {
  constructor() {
    super('Slack channel not found.');
    this.name = 'SlackDeliveryChannelNotFoundError';
  }
}
