import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { createWebhookNotification } from '@watchrail/contracts';
import type { WatchrailDatabase } from './client.js';
import {
  monitors,
  notificationDeliveries,
  notificationEvents,
  webhookEndpoints,
  webhookEndpointVersions,
} from './schema.js';

type Transaction = Parameters<Parameters<WatchrailDatabase['transaction']>[0]>[0];
export type IncidentTransition =
  | { type: 'NONE' }
  | {
      type: 'OPENED' | 'RESOLVED';
      incident: {
        id: string;
        status: 'OPEN' | 'RESOLVED';
        startedAt: Date;
        openedAt: Date;
        resolvedAt: Date | null;
      };
      organizationId: string;
      monitorId: string;
      triggeringRoundId: string;
    };

export async function stageIncidentNotification(
  tx: Transaction,
  transition: IncidentTransition,
): Promise<void> {
  if (transition.type === 'NONE') return;
  const [monitor] = await tx
    .select({ name: monitors.name })
    .from(monitors)
    .where(
      and(
        eq(monitors.organizationId, transition.organizationId),
        eq(monitors.id, transition.monitorId),
      ),
    )
    .limit(1);
  if (!monitor) throw new Error('Notification monitor is missing.');
  const eventId = randomUUID();
  const eventType = transition.type === 'OPENED' ? 'INCIDENT_OPENED' : 'INCIDENT_RESOLVED';
  const occurredAt =
    transition.type === 'OPENED' ? transition.incident.openedAt : transition.incident.resolvedAt;
  if (!occurredAt) throw new Error('Resolved notification is missing its occurrence time.');
  const payload = createWebhookNotification({
    eventId,
    eventType,
    occurredAt,
    organizationId: transition.organizationId,
    monitor: { id: transition.monitorId, name: monitor.name },
    incident: transition.incident,
    triggeringRoundId: transition.triggeringRoundId,
  });
  await tx.insert(notificationEvents).values({
    id: eventId,
    organizationId: transition.organizationId,
    monitorId: transition.monitorId,
    incidentId: transition.incident.id,
    eventType,
    occurredAt,
    triggeringRoundId: transition.triggeringRoundId,
    payload,
  });
  const endpoints = await tx
    .select({ endpointId: webhookEndpoints.id, endpointVersionId: webhookEndpointVersions.id })
    .from(webhookEndpoints)
    .leftJoin(
      webhookEndpointVersions,
      and(
        eq(webhookEndpointVersions.organizationId, webhookEndpoints.organizationId),
        eq(webhookEndpointVersions.endpointId, webhookEndpoints.id),
        eq(webhookEndpointVersions.versionNumber, webhookEndpoints.currentVersionNumber),
      ),
    )
    .where(
      and(
        eq(webhookEndpoints.organizationId, transition.organizationId),
        eq(webhookEndpoints.enabled, true),
      ),
    );
  if (endpoints.some((endpoint) => endpoint.endpointVersionId === null)) {
    throw new Error('Enabled webhook endpoint is missing its current immutable version.');
  }
  if (endpoints.length > 0)
    await tx.insert(notificationDeliveries).values(
      endpoints.map((endpoint) => ({
        organizationId: transition.organizationId,
        eventId,
        endpointId: endpoint.endpointId,
        endpointVersionId: endpoint.endpointVersionId!,
      })),
    );
}
