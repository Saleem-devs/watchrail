import { and, eq, isNull, sql } from 'drizzle-orm';
import type { WatchrailDatabase } from './client.js';
import {
  notificationDeliveries,
  webhookEndpointMonitorRoutes,
  webhookEndpoints,
} from './schema.js';

export type NotificationChannelType = 'EMAIL' | 'SLACK' | 'WEBHOOK';

/**
 * Archives a notification channel while retaining immutable configuration and
 * delivery evidence. Pending and claimed deliveries are suppressed so an
 * archived channel cannot be retried or authoritatively acknowledged.
 */
export async function archiveNotificationChannel(
  db: WatchrailDatabase,
  organizationId: string,
  channelId: string,
  channelType: NotificationChannelType,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [channel] = await tx
      .select({ id: webhookEndpoints.id })
      .from(webhookEndpoints)
      .where(
        and(
          eq(webhookEndpoints.organizationId, organizationId),
          eq(webhookEndpoints.id, channelId),
          eq(webhookEndpoints.channelType, channelType),
          isNull(webhookEndpoints.archivedAt),
        ),
      )
      .limit(1)
      .for('update');
    if (!channel) return false;

    const archivedAt = sql`clock_timestamp()`;
    await tx
      .update(webhookEndpoints)
      .set({ enabled: false, archivedAt, updatedAt: archivedAt })
      .where(
        and(
          eq(webhookEndpoints.organizationId, organizationId),
          eq(webhookEndpoints.id, channelId),
          eq(webhookEndpoints.channelType, channelType),
          isNull(webhookEndpoints.archivedAt),
        ),
      );
    await tx
      .delete(webhookEndpointMonitorRoutes)
      .where(
        and(
          eq(webhookEndpointMonitorRoutes.organizationId, organizationId),
          eq(webhookEndpointMonitorRoutes.endpointId, channelId),
        ),
      );
    await tx
      .update(notificationDeliveries)
      .set({
        claimToken: null,
        suppressedAt: archivedAt,
        suppressionReason: 'CHANNEL_DELETED',
      })
      .where(
        and(
          eq(notificationDeliveries.organizationId, organizationId),
          eq(notificationDeliveries.endpointId, channelId),
          isNull(notificationDeliveries.deliveredAt),
          isNull(notificationDeliveries.deadAt),
          isNull(notificationDeliveries.suppressedAt),
        ),
      );
    return true;
  });
}
