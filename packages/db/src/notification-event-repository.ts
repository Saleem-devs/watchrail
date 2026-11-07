import { randomUUID } from 'node:crypto';
import { and, eq, isNull, or, sql } from 'drizzle-orm';
import { createWebhookNotification } from '@watchrail/contracts';
import type { WatchrailDatabase } from './client.js';
import {
  incidents,
  monitors,
  notificationDeliveries,
  notificationEvents,
  projects,
  webhookEndpointMonitorRoutes,
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
    .select({
      name: monitors.name,
      projectId: monitors.projectId,
      reminderDelaysMinutes: projects.incidentReminderDelaysMinutes,
    })
    .from(monitors)
    .innerJoin(
      projects,
      and(
        eq(projects.organizationId, monitors.organizationId),
        eq(projects.id, monitors.projectId),
      ),
    )
    .where(
      and(
        eq(monitors.organizationId, transition.organizationId),
        eq(monitors.id, transition.monitorId),
      ),
    )
    .limit(1);
  if (!monitor) throw new Error('Notification monitor is missing.');
  const [incidentMetadata] = await tx
    .select({ groupKey: incidents.groupKey, severity: incidents.severity })
    .from(incidents)
    .where(
      and(
        eq(incidents.organizationId, transition.organizationId),
        eq(incidents.id, transition.incident.id),
      ),
    )
    .limit(1);
  if (!incidentMetadata) throw new Error('Notification incident is missing.');
  const eventId = randomUUID();
  const eventType = transition.type === 'OPENED' ? 'INCIDENT_OPENED' : 'INCIDENT_RESOLVED';
  const occurredAt =
    transition.type === 'OPENED' ? transition.incident.openedAt : transition.incident.resolvedAt;
  if (!occurredAt) throw new Error('Resolved notification is missing its occurrence time.');
  if (transition.type === 'RESOLVED') {
    const [incidentPolicy] = await tx
      .select({ silencedUntil: incidents.silencedUntil })
      .from(incidents)
      .where(
        and(
          eq(incidents.organizationId, transition.organizationId),
          eq(incidents.id, transition.incident.id),
        ),
      )
      .limit(1);
    if (!incidentPolicy) throw new Error('Notification incident is missing.');
    if (incidentPolicy.silencedUntil && incidentPolicy.silencedUntil > occurredAt) return;
  }
  const payload = createWebhookNotification({
    eventId,
    eventType,
    occurredAt,
    organizationId: transition.organizationId,
    monitor: { id: transition.monitorId, name: monitor.name },
    incident: { ...transition.incident, ...incidentMetadata },
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
      webhookEndpointMonitorRoutes,
      and(
        eq(webhookEndpointMonitorRoutes.organizationId, webhookEndpoints.organizationId),
        eq(webhookEndpointMonitorRoutes.endpointId, webhookEndpoints.id),
        eq(webhookEndpointMonitorRoutes.monitorId, transition.monitorId),
      ),
    )
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
        isNull(webhookEndpoints.archivedAt),
        or(
          isNull(webhookEndpoints.projectId),
          and(
            eq(webhookEndpoints.projectId, monitor.projectId),
            or(
              eq(webhookEndpoints.routeAllMonitors, true),
              eq(webhookEndpointMonitorRoutes.monitorId, transition.monitorId),
            ),
            transition.type === 'OPENED'
              ? eq(webhookEndpoints.notifyOnIncident, true)
              : eq(webhookEndpoints.notifyOnRecovery, true),
          ),
        ),
      ),
    );
  if (endpoints.some((endpoint) => endpoint.endpointVersionId === null)) {
    throw new Error('Enabled webhook endpoint is missing its current immutable version.');
  }
  if (endpoints.length > 0) {
    const reminderDelaysMinutes = transition.type === 'OPENED' ? monitor.reminderDelaysMinutes : [];
    const staged = await tx.execute<{ stagedAt: Date | string }>(sql`
      select date_trunc('milliseconds', clock_timestamp()) as "stagedAt"
    `);
    const stagedAtValue = staged.rows[0]?.stagedAt;
    if (!stagedAtValue) throw new Error('Notification staging clock is unavailable.');
    const stagedAt = stagedAtValue instanceof Date ? stagedAtValue : new Date(stagedAtValue);
    await tx.insert(notificationDeliveries).values(
      endpoints.flatMap((endpoint) =>
        [0, ...reminderDelaysMinutes].map((delayMinutes, deliverySequence) => ({
          organizationId: transition.organizationId,
          eventId,
          endpointId: endpoint.endpointId,
          endpointVersionId: endpoint.endpointVersionId!,
          deliverySequence,
          availableAt: new Date(stagedAt.getTime() + delayMinutes * 60_000),
        })),
      ),
    );
  }
}
