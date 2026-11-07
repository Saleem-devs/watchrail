import type { EmailChannelRecord, EmailDeliveryListItem } from '@watchrail/db';

export function presentEmailChannel(channel: EmailChannelRecord) {
  return {
    id: channel.id,
    projectId: channel.projectId,
    type: 'EMAIL' as const,
    name: channel.name,
    enabled: channel.enabled,
    versionNumber: channel.versionNumber,
    recipientEmails: channel.recipientEmails,
    routing: channel.routing,
    createdAt: channel.createdAt.toISOString(),
    updatedAt: channel.updatedAt.toISOString(),
  };
}

export function presentEmailDelivery(delivery: EmailDeliveryListItem) {
  return {
    id: delivery.id,
    deliverySequence: delivery.deliverySequence,
    event: {
      ...delivery.event,
      occurredAt: delivery.event.occurredAt.toISOString(),
    },
    status: delivery.status,
    attemptCount: delivery.attemptCount,
    lastAttemptAt: delivery.lastAttemptAt?.toISOString() ?? null,
    lastErrorCode: delivery.lastErrorCode,
    lastHttpStatus: null,
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
