import type { SlackChannelRecord, SlackDeliveryListItem } from '@watchrail/db';

export function presentSlackChannel(channel: SlackChannelRecord) {
  return {
    id: channel.id,
    projectId: channel.projectId,
    type: 'SLACK' as const,
    name: channel.name,
    enabled: channel.enabled,
    versionNumber: channel.versionNumber,
    webhookUrl: channel.webhookUrl,
    routing: channel.routing,
    createdAt: channel.createdAt.toISOString(),
    updatedAt: channel.updatedAt.toISOString(),
  };
}

export function presentSlackDelivery(delivery: SlackDeliveryListItem) {
  return {
    id: delivery.id,
    event: { ...delivery.event, occurredAt: delivery.event.occurredAt.toISOString() },
    status: delivery.status,
    attemptCount: delivery.attemptCount,
    lastAttemptAt: delivery.lastAttemptAt?.toISOString() ?? null,
    lastErrorCode: delivery.lastErrorCode,
    lastHttpStatus: delivery.lastHttpStatus,
    nextAttemptAt: delivery.nextAttemptAt?.toISOString() ?? null,
    leaseExpiresAt: delivery.leaseExpiresAt?.toISOString() ?? null,
    deliveredAt: delivery.deliveredAt?.toISOString() ?? null,
    deadAt: delivery.deadAt?.toISOString() ?? null,
    deadReason: delivery.deadReason,
    suppressedAt: delivery.suppressedAt?.toISOString() ?? null,
    suppressionReason: delivery.suppressionReason,
    createdAt: delivery.createdAt.toISOString(),
  };
}
