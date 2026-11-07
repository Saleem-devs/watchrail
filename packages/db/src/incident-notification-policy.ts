import { sql } from 'drizzle-orm';
import type { WatchrailDatabase } from './client.js';

type Transaction = Parameters<Parameters<WatchrailDatabase['transaction']>[0]>[0];

export async function suppressClaimedDeliveryForIncidentSilence(
  tx: Transaction,
  input: {
    deliveryId: string;
    claimToken: string;
    organizationId: string;
    policyAt: Date;
  },
): Promise<boolean> {
  const result = await tx.execute<{ id: string }>(sql`
    update notification_deliveries delivery set
      claim_token=null,
      suppressed_at=${input.policyAt},
      suppression_reason='INCIDENT_SILENCED',
      last_error_code=null,
      last_http_status=null
    where delivery.id=${input.deliveryId}::uuid
      and delivery.organization_id=${input.organizationId}::uuid
      and delivery.claim_token=${input.claimToken}::uuid
      and delivery.delivered_at is null
      and delivery.dead_at is null
      and delivery.suppressed_at is null
      and exists (
        select 1
        from notification_events event
        join incidents incident
          on incident.organization_id=event.organization_id
          and incident.id=event.incident_id
        where event.organization_id=delivery.organization_id
          and event.id=delivery.event_id
          and incident.silenced_until > ${input.policyAt}
      )
    returning delivery.id
  `);
  return result.rowCount === 1;
}

export async function suppressClaimedReminderForClosedIncident(
  tx: Transaction,
  input: {
    deliveryId: string;
    claimToken: string;
    organizationId: string;
    policyAt: Date;
  },
): Promise<boolean> {
  const result = await tx.execute<{ id: string }>(sql`
    update notification_deliveries delivery set
      claim_token=null,
      suppressed_at=${input.policyAt},
      suppression_reason='INCIDENT_CLOSED',
      last_error_code=null,
      last_http_status=null
    where delivery.id=${input.deliveryId}::uuid
      and delivery.organization_id=${input.organizationId}::uuid
      and delivery.claim_token=${input.claimToken}::uuid
      and delivery.delivery_sequence > 0
      and delivery.delivered_at is null
      and delivery.dead_at is null
      and delivery.suppressed_at is null
      and exists (
        select 1
        from notification_events event
        join incidents incident
          on incident.organization_id=event.organization_id
          and incident.id=event.incident_id
        where event.organization_id=delivery.organization_id
          and event.id=delivery.event_id
          and event.event_type='INCIDENT_OPENED'
          and incident.status <> 'OPEN'
      )
    returning delivery.id
  `);
  return result.rowCount === 1;
}
