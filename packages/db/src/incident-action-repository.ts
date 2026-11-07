import { and, asc, eq, sql } from 'drizzle-orm';
import type { WatchrailDatabase } from './client.js';
import { incidentActionEvents, incidents, monitorIncidentState } from './schema.js';

type Transaction = Parameters<Parameters<WatchrailDatabase['transaction']>[0]>[0];
export type IncidentActionRecord = typeof incidents.$inferSelect;

export interface IncidentActionEventRecord {
  id: string;
  incidentId: string;
  actorId: string;
  action: 'ACKNOWLEDGED' | 'SILENCED' | 'UNSILENCED' | 'MANUALLY_RESOLVED';
  silenceUntil: Date | null;
  note: string | null;
  occurredAt: Date;
}

export class IncidentActionNotFoundError extends Error {
  constructor() {
    super('Incident not found.');
    this.name = 'IncidentActionNotFoundError';
  }
}

export class IncidentActionConflictError extends Error {
  constructor(message = 'Only open incidents can be changed.') {
    super(message);
    this.name = 'IncidentActionConflictError';
  }
}

export class IncidentSilenceWindowError extends Error {
  constructor() {
    super('Silence expiry must be in the future and no more than 30 days away.');
    this.name = 'IncidentSilenceWindowError';
  }
}

export class IncidentResolutionNoteError extends Error {
  constructor() {
    super('Resolution note must be 500 characters or fewer.');
    this.name = 'IncidentResolutionNoteError';
  }
}

export class IncidentActionRepository {
  constructor(private readonly db: WatchrailDatabase) {}

  async acknowledge(
    organizationId: string,
    incidentId: string,
    actorId: string,
  ): Promise<IncidentActionRecord> {
    return this.db.transaction(async (tx) => {
      const incident = await lockIncident(tx, organizationId, incidentId);
      assertOpen(incident);
      if (incident.acknowledgedAt) return incident;
      const [updated] = await tx
        .update(incidents)
        .set({
          acknowledgedAt: sql`clock_timestamp()`,
          acknowledgedByActorId: actorId,
        })
        .where(and(eq(incidents.organizationId, organizationId), eq(incidents.id, incidentId)))
        .returning();
      if (!updated) throw new IncidentActionNotFoundError();
      await tx.insert(incidentActionEvents).values({
        organizationId,
        incidentId,
        actorId,
        action: 'ACKNOWLEDGED',
        occurredAt: sql`clock_timestamp()`,
      });
      return updated;
    });
  }

  async silence(
    organizationId: string,
    incidentId: string,
    actorId: string,
    silenceUntil: Date,
  ): Promise<IncidentActionRecord> {
    return this.db.transaction(async (tx) => {
      const incident = await lockIncident(tx, organizationId, incidentId);
      assertOpen(incident);
      const now = await databaseNow(tx);
      if (
        !Number.isFinite(silenceUntil.getTime()) ||
        silenceUntil.getTime() <= now.getTime() ||
        silenceUntil.getTime() > now.getTime() + 30 * 24 * 60 * 60 * 1_000
      ) {
        throw new IncidentSilenceWindowError();
      }
      if (incident.silencedUntil?.getTime() === silenceUntil.getTime()) return incident;
      const [updated] = await tx
        .update(incidents)
        .set({
          silencedAt: now,
          silencedUntil: silenceUntil,
          silencedByActorId: actorId,
        })
        .where(and(eq(incidents.organizationId, organizationId), eq(incidents.id, incidentId)))
        .returning();
      if (!updated) throw new IncidentActionNotFoundError();
      await tx.insert(incidentActionEvents).values({
        organizationId,
        incidentId,
        actorId,
        action: 'SILENCED',
        silenceUntil,
        occurredAt: sql`clock_timestamp()`,
      });
      return updated;
    });
  }

  async unsilence(
    organizationId: string,
    incidentId: string,
    actorId: string,
  ): Promise<IncidentActionRecord> {
    return this.db.transaction(async (tx) => {
      const incident = await lockIncident(tx, organizationId, incidentId);
      assertOpen(incident);
      if (!incident.silencedUntil) return incident;
      const [updated] = await tx
        .update(incidents)
        .set({ silencedAt: null, silencedUntil: null, silencedByActorId: null })
        .where(and(eq(incidents.organizationId, organizationId), eq(incidents.id, incidentId)))
        .returning();
      if (!updated) throw new IncidentActionNotFoundError();
      await tx.insert(incidentActionEvents).values({
        organizationId,
        incidentId,
        actorId,
        action: 'UNSILENCED',
        occurredAt: sql`clock_timestamp()`,
      });
      return updated;
    });
  }

  async resolve(
    organizationId: string,
    incidentId: string,
    actorId: string,
    rawNote: string | null,
  ): Promise<IncidentActionRecord> {
    const note = rawNote?.trim() || null;
    if (note && note.length > 500) throw new IncidentResolutionNoteError();
    return this.db.transaction(async (tx) => {
      const identity = await findIncidentIdentity(tx, organizationId, incidentId);
      const [state] = await tx
        .select({ monitorId: monitorIncidentState.monitorId })
        .from(monitorIncidentState)
        .where(
          and(
            eq(monitorIncidentState.organizationId, organizationId),
            eq(monitorIncidentState.monitorId, identity.monitorId),
          ),
        )
        .limit(1)
        .for('update');
      if (!state) throw new Error('Monitor incident state is missing.');
      const incident = await lockIncident(tx, organizationId, incidentId);
      assertOpen(incident);
      const [updated] = await tx
        .update(incidents)
        .set({
          status: 'RESOLVED',
          resolvedAt: sql`greatest(${incidents.openedAt}, clock_timestamp())`,
          resolvedByRoundId: null,
          resolvedByActorId: actorId,
          resolutionNote: note,
        })
        .where(and(eq(incidents.organizationId, organizationId), eq(incidents.id, incidentId)))
        .returning();
      if (!updated) throw new IncidentActionNotFoundError();
      await tx
        .update(monitorIncidentState)
        .set({
          trackingStartedAt: updated.resolvedAt!,
          consecutiveFailures: 0,
          failureStreakStartedAt: null,
          failureStreakStartedRoundId: null,
          multiLocationSeverity: null,
          multiLocationHealthyRecoveryStreak: 0,
          updatedAt: sql`clock_timestamp()`,
        })
        .where(
          and(
            eq(monitorIncidentState.organizationId, organizationId),
            eq(monitorIncidentState.monitorId, identity.monitorId),
          ),
        );
      await tx.insert(incidentActionEvents).values({
        organizationId,
        incidentId,
        actorId,
        action: 'MANUALLY_RESOLVED',
        note,
        occurredAt: sql`clock_timestamp()`,
      });
      return updated;
    });
  }

  async listEvents(
    organizationId: string,
    incidentId: string,
  ): Promise<IncidentActionEventRecord[]> {
    await findIncidentIdentity(this.db, organizationId, incidentId);
    return this.db
      .select({
        id: incidentActionEvents.id,
        incidentId: incidentActionEvents.incidentId,
        actorId: incidentActionEvents.actorId,
        action: incidentActionEvents.action,
        silenceUntil: incidentActionEvents.silenceUntil,
        note: incidentActionEvents.note,
        occurredAt: incidentActionEvents.occurredAt,
      })
      .from(incidentActionEvents)
      .where(
        and(
          eq(incidentActionEvents.organizationId, organizationId),
          eq(incidentActionEvents.incidentId, incidentId),
        ),
      )
      .orderBy(asc(incidentActionEvents.occurredAt), asc(incidentActionEvents.id));
  }
}

async function findIncidentIdentity(
  tx: Transaction | WatchrailDatabase,
  organizationId: string,
  incidentId: string,
): Promise<{ monitorId: string }> {
  const [incident] = await tx
    .select({ monitorId: incidents.monitorId })
    .from(incidents)
    .where(and(eq(incidents.organizationId, organizationId), eq(incidents.id, incidentId)))
    .limit(1);
  if (!incident) throw new IncidentActionNotFoundError();
  return incident;
}

async function lockIncident(
  tx: Transaction,
  organizationId: string,
  incidentId: string,
): Promise<IncidentActionRecord> {
  const [incident] = await tx
    .select()
    .from(incidents)
    .where(and(eq(incidents.organizationId, organizationId), eq(incidents.id, incidentId)))
    .limit(1)
    .for('update');
  if (!incident) throw new IncidentActionNotFoundError();
  return incident;
}

function assertOpen(incident: IncidentActionRecord): void {
  if (incident.status !== 'OPEN') throw new IncidentActionConflictError();
}

async function databaseNow(tx: Transaction): Promise<Date> {
  const result = await tx.execute<{ value: string }>(
    sql`select date_trunc('milliseconds', clock_timestamp()) as value`,
  );
  const value = result.rows[0]?.value;
  if (!value) throw new Error('Database clock query returned no record.');
  return new Date(value);
}
