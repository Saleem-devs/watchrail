import { and, asc, desc, eq, gte, inArray, or, sql } from 'drizzle-orm';
import {
  STATUS_PAGE_RESOLVED_INCIDENT_RETENTION_DAYS,
  derivePublicComponentStatus,
  derivePublicPageStatus,
  resolvedIncidentIsPublic,
  type AggregateHealthState,
  type PublicStatusPageIncidentV1,
  type PublicStatusPageProjectionV1,
} from '@watchrail/domain';
import type { WatchrailDatabase } from './client.js';
import {
  incidents,
  monitorAvailabilityState,
  monitors,
  statusPageComponents,
  statusPages,
} from './schema.js';

export class PublicStatusPageStateInvariantError extends Error {
  constructor() {
    super('Public status page state is incomplete.');
    this.name = 'PublicStatusPageStateInvariantError';
  }
}

export class PublicStatusPageRepository {
  constructor(private readonly db: WatchrailDatabase) {}

  async findPublishedBySlug(slug: string): Promise<PublicStatusPageProjectionV1 | null> {
    return this.db.transaction(
      async (tx) => {
        const clock = await tx.execute<{ cutoff: string }>(
          sql`select date_trunc('milliseconds', clock_timestamp()) as cutoff`,
        );
        const cutoff = new Date(clock.rows[0]!.cutoff);
        const [page] = await tx
          .select({ id: statusPages.id, name: statusPages.name, slug: statusPages.slug })
          .from(statusPages)
          .where(and(eq(statusPages.slug, slug), eq(statusPages.published, true)))
          .limit(1);
        if (!page) return null;

        const rows = await tx
          .select({
            componentId: statusPageComponents.id,
            displayName: statusPageComponents.displayName,
            monitorId: statusPageComponents.monitorId,
            position: statusPageComponents.position,
            lifecycleState: monitors.lifecycleState,
            availabilityState: monitorAvailabilityState.currentState,
            activeIncidentId: incidents.id,
            activeIncidentSeverity: incidents.severity,
          })
          .from(statusPageComponents)
          .innerJoin(
            monitors,
            and(
              eq(monitors.id, statusPageComponents.monitorId),
              eq(monitors.organizationId, statusPageComponents.organizationId),
            ),
          )
          .leftJoin(
            monitorAvailabilityState,
            and(
              eq(monitorAvailabilityState.monitorId, statusPageComponents.monitorId),
              eq(monitorAvailabilityState.organizationId, statusPageComponents.organizationId),
            ),
          )
          .leftJoin(
            incidents,
            and(
              eq(incidents.monitorId, statusPageComponents.monitorId),
              eq(incidents.organizationId, statusPageComponents.organizationId),
              eq(incidents.status, 'OPEN'),
            ),
          )
          .where(eq(statusPageComponents.statusPageId, page.id))
          .orderBy(asc(statusPageComponents.position), asc(statusPageComponents.id));

        const componentByMonitor = new Map(rows.map((row) => [row.monitorId, row.componentId]));
        const components = rows.map((row) => {
          if (!row.availabilityState) throw new PublicStatusPageStateInvariantError();
          const aggregateState: AggregateHealthState = row.activeIncidentId
            ? row.activeIncidentSeverity === 'DEGRADED'
              ? 'DEGRADED'
              : 'DOWN'
            : row.availabilityState === 'AVAILABLE'
              ? 'UP'
              : 'UNKNOWN';
          return {
            id: row.componentId,
            displayName: row.displayName,
            position: row.position,
            status: derivePublicComponentStatus({
              lifecycleState: row.lifecycleState,
              aggregateState,
            }),
          };
        });

        const incidentRows =
          rows.length === 0
            ? []
            : await tx
                .select({
                  id: incidents.id,
                  monitorId: incidents.monitorId,
                  status: incidents.status,
                  startedAt: incidents.startedAt,
                  openedAt: incidents.openedAt,
                  resolvedAt: incidents.resolvedAt,
                })
                .from(incidents)
                .where(
                  and(
                    inArray(
                      incidents.monitorId,
                      rows.map(({ monitorId }) => monitorId),
                    ),
                    or(
                      eq(incidents.status, 'OPEN'),
                      and(
                        eq(incidents.status, 'RESOLVED'),
                        gte(
                          incidents.resolvedAt,
                          new Date(
                            cutoff.getTime() -
                              STATUS_PAGE_RESOLVED_INCIDENT_RETENTION_DAYS * 24 * 60 * 60 * 1_000,
                          ),
                        ),
                      ),
                    ),
                  ),
                )
                .orderBy(desc(incidents.openedAt), desc(incidents.id));

        const activeIncidents: PublicStatusPageIncidentV1[] = [];
        const resolvedIncidents: PublicStatusPageIncidentV1[] = [];
        for (const incident of incidentRows) {
          const componentId = componentByMonitor.get(incident.monitorId);
          if (!componentId) throw new PublicStatusPageStateInvariantError();
          if (
            incident.status === 'RESOLVED' &&
            (!incident.resolvedAt || !resolvedIncidentIsPublic(incident.resolvedAt, cutoff))
          ) {
            continue;
          }
          const projection: PublicStatusPageIncidentV1 = {
            id: incident.id,
            componentId,
            status: incident.status,
            startedAt: incident.startedAt.toISOString(),
            openedAt: incident.openedAt.toISOString(),
            resolvedAt: incident.resolvedAt?.toISOString() ?? null,
          };
          if (incident.status === 'OPEN') activeIncidents.push(projection);
          else resolvedIncidents.push(projection);
        }

        return {
          contractVersion: 1,
          name: page.name,
          slug: page.slug,
          status: derivePublicPageStatus(components.map(({ status }) => status)),
          components,
          activeIncidents,
          resolvedIncidents,
          generatedAt: cutoff.toISOString(),
        };
      },
      { isolationLevel: 'repeatable read', accessMode: 'read only' },
    );
  }
}
