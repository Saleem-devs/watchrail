import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import {
  canTransitionStatusPageIncident,
  parseStatusPageIncidentCreate,
  parseStatusPageIncidentUpdate,
  type StatusPageIncidentImpact,
  type StatusPageIncidentState,
} from '@watchrail/domain';
import type { WatchrailDatabase } from './client.js';
import {
  statusPageComponents,
  statusPageIncidentComponents,
  statusPageIncidents,
  statusPageIncidentUpdates,
  statusPages,
} from './schema.js';

type Transaction = Parameters<Parameters<WatchrailDatabase['transaction']>[0]>[0];

export interface StatusPageIncidentRecord {
  id: string;
  statusPageId: string;
  title: string;
  impact: StatusPageIncidentImpact;
  state: StatusPageIncidentState;
  startedAt: Date;
  resolvedAt: Date | null;
  updatedAt: Date;
  components: Array<{ id: string; displayName: string; position: number }>;
  updates: Array<{
    id: string;
    sequence: number;
    state: StatusPageIncidentState;
    message: string;
    createdByActorId: string;
    createdAt: Date;
  }>;
}

export class StatusPageIncidentNotFoundError extends Error {
  constructor() {
    super('Status page incident not found.');
    this.name = 'StatusPageIncidentNotFoundError';
  }
}

export class StatusPageIncidentComponentSelectionError extends Error {
  constructor() {
    super('Select components that belong to this status page.');
    this.name = 'StatusPageIncidentComponentSelectionError';
  }
}

export class StatusPageIncidentTransitionError extends Error {
  constructor(
    readonly current: StatusPageIncidentState,
    readonly next: StatusPageIncidentState,
  ) {
    super(`A status page incident cannot move from ${current} to ${next}.`);
    this.name = 'StatusPageIncidentTransitionError';
  }
}

export class StatusPageIncidentRepository {
  constructor(private readonly db: WatchrailDatabase) {}

  async create(
    organizationId: string,
    statusPageId: string,
    actorId: string,
    input: unknown,
  ): Promise<StatusPageIncidentRecord> {
    const parsed = parseStatusPageIncidentCreate(input);
    return this.db.transaction(async (tx) => {
      await this.assertPage(tx, organizationId, statusPageId);
      const selected = await tx
        .select({
          id: statusPageComponents.id,
          displayName: statusPageComponents.displayName,
          position: statusPageComponents.position,
        })
        .from(statusPageComponents)
        .where(
          and(
            eq(statusPageComponents.organizationId, organizationId),
            eq(statusPageComponents.statusPageId, statusPageId),
            inArray(statusPageComponents.id, parsed.componentIds),
          ),
        )
        .orderBy(asc(statusPageComponents.position));
      if (selected.length !== parsed.componentIds.length) {
        throw new StatusPageIncidentComponentSelectionError();
      }

      const incidentId = randomUUID();
      const clock = await this.clock(tx);
      await tx.insert(statusPageIncidents).values({
        id: incidentId,
        organizationId,
        statusPageId,
        title: parsed.title,
        impact: parsed.impact,
        state: 'INVESTIGATING',
        createdByActorId: actorId,
        startedAt: clock,
        updatedAt: clock,
      });
      await tx.insert(statusPageIncidentComponents).values(
        selected.map((component, position) => ({
          organizationId,
          incidentId,
          componentId: component.id,
          displayName: component.displayName,
          position,
        })),
      );
      await tx.insert(statusPageIncidentUpdates).values({
        id: randomUUID(),
        organizationId,
        incidentId,
        sequence: 1,
        state: 'INVESTIGATING',
        message: parsed.message,
        createdByActorId: actorId,
        createdAt: clock,
      });
      return this.loadOne(tx, organizationId, statusPageId, incidentId);
    });
  }

  async appendUpdate(
    organizationId: string,
    statusPageId: string,
    incidentId: string,
    actorId: string,
    input: unknown,
  ): Promise<StatusPageIncidentRecord> {
    const parsed = parseStatusPageIncidentUpdate(input);
    return this.db.transaction(async (tx) => {
      const [incident] = await tx
        .select()
        .from(statusPageIncidents)
        .where(
          and(
            eq(statusPageIncidents.organizationId, organizationId),
            eq(statusPageIncidents.statusPageId, statusPageId),
            eq(statusPageIncidents.id, incidentId),
          ),
        )
        .limit(1)
        .for('update');
      if (!incident) throw new StatusPageIncidentNotFoundError();
      if (!canTransitionStatusPageIncident(incident.state, parsed.state)) {
        throw new StatusPageIncidentTransitionError(incident.state, parsed.state);
      }
      const clock = await this.clock(tx);
      const counts = await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(statusPageIncidentUpdates)
        .where(
          and(
            eq(statusPageIncidentUpdates.organizationId, organizationId),
            eq(statusPageIncidentUpdates.incidentId, incidentId),
          ),
        );
      const count = counts[0]?.count ?? 0;
      await tx.insert(statusPageIncidentUpdates).values({
        id: randomUUID(),
        organizationId,
        incidentId,
        sequence: count + 1,
        state: parsed.state,
        message: parsed.message,
        createdByActorId: actorId,
        createdAt: clock,
      });
      await tx
        .update(statusPageIncidents)
        .set({
          state: parsed.state,
          resolvedAt: parsed.state === 'RESOLVED' ? clock : null,
          updatedAt: clock,
        })
        .where(
          and(
            eq(statusPageIncidents.organizationId, organizationId),
            eq(statusPageIncidents.id, incidentId),
          ),
        );
      return this.loadOne(tx, organizationId, statusPageId, incidentId);
    });
  }

  async list(organizationId: string, statusPageId: string): Promise<StatusPageIncidentRecord[]> {
    const page = await this.db
      .select({ id: statusPages.id })
      .from(statusPages)
      .where(and(eq(statusPages.organizationId, organizationId), eq(statusPages.id, statusPageId)))
      .limit(1);
    if (page.length === 0) throw new StatusPageIncidentNotFoundError();
    const rows = await this.db
      .select({ id: statusPageIncidents.id })
      .from(statusPageIncidents)
      .where(
        and(
          eq(statusPageIncidents.organizationId, organizationId),
          eq(statusPageIncidents.statusPageId, statusPageId),
        ),
      )
      .orderBy(desc(statusPageIncidents.startedAt), desc(statusPageIncidents.id));
    return Promise.all(
      rows.map(({ id }) => this.loadOne(this.db, organizationId, statusPageId, id)),
    );
  }

  async find(
    organizationId: string,
    statusPageId: string,
    incidentId: string,
  ): Promise<StatusPageIncidentRecord | null> {
    try {
      return await this.loadOne(this.db, organizationId, statusPageId, incidentId);
    } catch (error) {
      if (error instanceof StatusPageIncidentNotFoundError) return null;
      throw error;
    }
  }

  private async loadOne(
    tx: Transaction | WatchrailDatabase,
    organizationId: string,
    statusPageId: string,
    incidentId: string,
  ): Promise<StatusPageIncidentRecord> {
    const [incident] = await tx
      .select()
      .from(statusPageIncidents)
      .where(
        and(
          eq(statusPageIncidents.organizationId, organizationId),
          eq(statusPageIncidents.statusPageId, statusPageId),
          eq(statusPageIncidents.id, incidentId),
        ),
      )
      .limit(1);
    if (!incident) throw new StatusPageIncidentNotFoundError();
    const [components, updates] = await Promise.all([
      tx
        .select({
          id: statusPageIncidentComponents.componentId,
          displayName: statusPageIncidentComponents.displayName,
          position: statusPageIncidentComponents.position,
        })
        .from(statusPageIncidentComponents)
        .where(
          and(
            eq(statusPageIncidentComponents.organizationId, organizationId),
            eq(statusPageIncidentComponents.incidentId, incidentId),
          ),
        )
        .orderBy(asc(statusPageIncidentComponents.position)),
      tx
        .select()
        .from(statusPageIncidentUpdates)
        .where(
          and(
            eq(statusPageIncidentUpdates.organizationId, organizationId),
            eq(statusPageIncidentUpdates.incidentId, incidentId),
          ),
        )
        .orderBy(asc(statusPageIncidentUpdates.sequence)),
    ]);
    return {
      id: incident.id,
      statusPageId: incident.statusPageId,
      title: incident.title,
      impact: incident.impact,
      state: incident.state,
      startedAt: incident.startedAt,
      resolvedAt: incident.resolvedAt,
      updatedAt: incident.updatedAt,
      components,
      updates: updates.map((update) => ({
        id: update.id,
        sequence: update.sequence,
        state: update.state,
        message: update.message,
        createdByActorId: update.createdByActorId,
        createdAt: update.createdAt,
      })),
    };
  }

  private async assertPage(tx: Transaction, organizationId: string, statusPageId: string) {
    const page = await tx
      .select({ id: statusPages.id })
      .from(statusPages)
      .where(and(eq(statusPages.organizationId, organizationId), eq(statusPages.id, statusPageId)))
      .limit(1)
      .for('share');
    if (page.length === 0) throw new StatusPageIncidentNotFoundError();
  }

  private async clock(tx: Transaction): Promise<Date> {
    const result = await tx.execute<{ now: string }>(
      sql`select date_trunc('milliseconds', clock_timestamp()) as now`,
    );
    return new Date(result.rows[0]!.now);
  }
}
