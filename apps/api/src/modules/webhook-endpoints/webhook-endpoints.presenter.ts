import type {
  WebhookDeliveryDetail,
  WebhookDeliveryListItem,
  WebhookEndpointRecord,
} from '@watchrail/db';

export function presentWebhookEndpoint(endpoint: WebhookEndpointRecord) {
  return {
    id: endpoint.id,
    name: endpoint.name,
    url: endpoint.url,
    enabled: endpoint.enabled,
    versionNumber: endpoint.versionNumber,
    signingSecret: { hasValue: true as const },
    createdAt: endpoint.createdAt.toISOString(),
    updatedAt: endpoint.updatedAt.toISOString(),
  };
}

export function presentWebhookDelivery(delivery: WebhookDeliveryListItem) {
  return {
    id: delivery.id,
    event: {
      id: delivery.event.id,
      type: delivery.event.type,
      occurredAt: delivery.event.occurredAt.toISOString(),
      monitorId: delivery.event.monitorId,
      incidentId: delivery.event.incidentId,
    },
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
    createdAt: delivery.createdAt.toISOString(),
  };
}

export function presentWebhookDeliveryDetail(delivery: WebhookDeliveryDetail) {
  return {
    ...presentWebhookDelivery(delivery),
    endpointId: delivery.endpointId,
    endpointVersion: {
      id: delivery.endpointVersion.id,
      versionNumber: delivery.endpointVersion.versionNumber,
      url: delivery.endpointVersion.url,
    },
    triggeringRoundId: delivery.triggeringRoundId,
  };
}
