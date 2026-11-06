import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import {
  parseMaintenanceWindowInput,
  type MaintenanceWindowAction,
  type MaintenanceWindowEffects,
  type MaintenanceWindowInput,
  type MaintenanceWindowSchedule,
  type MaintenanceWindowTarget,
} from '@watchrail/domain';
import type { WatchrailDatabase } from './client.js';
import {
  maintenanceWindowAuditEvents,
  maintenanceWindows,
  maintenanceWindowVersionMonitors,
  maintenanceWindowVersions,
  monitors,
  projects,
} from './schema.js';

type Transaction = Parameters<Parameters<WatchrailDatabase['transaction']>[0]>[0];
type MaintenanceWindowRow = typeof maintenanceWindows.$inferSelect;
type MaintenanceWindowVersionRow = typeof maintenanceWindowVersions.$inferSelect;

export interface MaintenanceWindowRecord {
  id: string;
  organizationId: string;
  projectId: string;
  versionNumber: number;
  name: string;
  schedule: MaintenanceWindowSchedule;
  target: MaintenanceWindowTarget;
  effects: MaintenanceWindowEffects;
  effectiveAt: Date;
  createdByActorId: string;
  archivedAt: Date | null;
  archivedByActorId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface MaintenanceWindowAuditRecord {
  id: string;
  action: MaintenanceWindowAction;
  versionNumber: number;
  actorId: string;
  occurredAt: Date;
}

export class MaintenanceWindowNotFoundError extends Error {
  constructor() {
    super('Maintenance window not found.');
    this.name = 'MaintenanceWindowNotFoundError';
  }
}

export class MaintenanceWindowProjectNotFoundError extends Error {
  constructor() {
    super('Project not found.');
    this.name = 'MaintenanceWindowProjectNotFoundError';
  }
}

export class MaintenanceWindowTargetError extends Error {
  constructor(readonly monitorIds: string[]) {
    super('Every selected monitor must belong to the maintenance window project.');
    this.name = 'MaintenanceWindowTargetError';
  }
}

export class MaintenanceWindowRepository {
  constructor(private readonly db: WatchrailDatabase) {}

  async create(
    organizationId: string,
    projectId: string,
    actorId: string,
    rawInput: unknown,
  ): Promise<MaintenanceWindowRecord> {
    const input = parseMaintenanceWindowInput(rawInput);
    return this.db.transaction(async (tx) => {
      await assertProject(tx, organizationId, projectId);
      await assertTargetMonitors(tx, organizationId, projectId, input.target);
      const [window] = await tx
        .insert(maintenanceWindows)
        .values({ organizationId, projectId, createdByActorId: actorId })
        .returning();
      if (!window) throw new Error('Maintenance window creation returned no record.');
      const version = await insertVersion(tx, window, actorId, input, 'CREATED');
      return toRecord(window, version, input.target);
    });
  }

  async listForProject(
    organizationId: string,
    projectId: string,
    options: { includeArchived?: boolean } = {},
  ): Promise<MaintenanceWindowRecord[]> {
    const rows = await this.db
      .select({ window: maintenanceWindows, version: maintenanceWindowVersions })
      .from(maintenanceWindows)
      .innerJoin(
        maintenanceWindowVersions,
        and(
          eq(maintenanceWindowVersions.organizationId, maintenanceWindows.organizationId),
          eq(maintenanceWindowVersions.maintenanceWindowId, maintenanceWindows.id),
          eq(maintenanceWindowVersions.versionNumber, maintenanceWindows.currentVersionNumber),
        ),
      )
      .where(
        and(
          eq(maintenanceWindows.organizationId, organizationId),
          eq(maintenanceWindows.projectId, projectId),
          options.includeArchived ? undefined : sql`${maintenanceWindows.archivedAt} is null`,
        ),
      )
      .orderBy(desc(maintenanceWindows.createdAt), desc(maintenanceWindows.id));
    const targets = await loadTargets(
      this.db,
      organizationId,
      rows.map(({ version }) => version),
    );
    return rows.map(({ window, version }) =>
      toRecord(window, version, targetFor(version, targets.get(version.id) ?? [])),
    );
  }

  async findForProject(
    organizationId: string,
    projectId: string,
    maintenanceWindowId: string,
  ): Promise<MaintenanceWindowRecord | null> {
    const [row] = await this.db
      .select({ window: maintenanceWindows, version: maintenanceWindowVersions })
      .from(maintenanceWindows)
      .innerJoin(
        maintenanceWindowVersions,
        and(
          eq(maintenanceWindowVersions.organizationId, maintenanceWindows.organizationId),
          eq(maintenanceWindowVersions.maintenanceWindowId, maintenanceWindows.id),
          eq(maintenanceWindowVersions.versionNumber, maintenanceWindows.currentVersionNumber),
        ),
      )
      .where(
        and(
          eq(maintenanceWindows.organizationId, organizationId),
          eq(maintenanceWindows.projectId, projectId),
          eq(maintenanceWindows.id, maintenanceWindowId),
        ),
      )
      .limit(1);
    if (!row) return null;
    const targets = await loadTargets(this.db, organizationId, [row.version]);
    return toRecord(
      row.window,
      row.version,
      targetFor(row.version, targets.get(row.version.id) ?? []),
    );
  }

  async update(
    organizationId: string,
    projectId: string,
    maintenanceWindowId: string,
    actorId: string,
    rawInput: unknown,
  ): Promise<MaintenanceWindowRecord> {
    const input = parseMaintenanceWindowInput(rawInput);
    return this.db.transaction(async (tx) => {
      const window = await lockWindow(tx, organizationId, projectId, maintenanceWindowId);
      if (window.archivedAt) throw new MaintenanceWindowNotFoundError();
      await assertTargetMonitors(tx, organizationId, projectId, input.target);
      const versionNumber = window.currentVersionNumber + 1;
      const [updated] = await tx
        .update(maintenanceWindows)
        .set({ currentVersionNumber: versionNumber, updatedAt: sql`clock_timestamp()` })
        .where(
          and(
            eq(maintenanceWindows.organizationId, organizationId),
            eq(maintenanceWindows.projectId, projectId),
            eq(maintenanceWindows.id, maintenanceWindowId),
          ),
        )
        .returning();
      if (!updated) throw new MaintenanceWindowNotFoundError();
      const version = await insertVersion(tx, updated, actorId, input, 'UPDATED');
      return toRecord(updated, version, input.target);
    });
  }

  async archive(
    organizationId: string,
    projectId: string,
    maintenanceWindowId: string,
    actorId: string,
  ): Promise<MaintenanceWindowRecord> {
    return this.db.transaction(async (tx) => {
      const window = await lockWindow(tx, organizationId, projectId, maintenanceWindowId);
      const [version] = await tx
        .select()
        .from(maintenanceWindowVersions)
        .where(
          and(
            eq(maintenanceWindowVersions.organizationId, organizationId),
            eq(maintenanceWindowVersions.maintenanceWindowId, maintenanceWindowId),
            eq(maintenanceWindowVersions.versionNumber, window.currentVersionNumber),
          ),
        )
        .limit(1);
      if (!version) throw new MaintenanceWindowNotFoundError();
      const targets = await loadTargets(tx, organizationId, [version]);
      if (window.archivedAt) {
        return toRecord(window, version, targetFor(version, targets.get(version.id) ?? []));
      }
      const [archived] = await tx
        .update(maintenanceWindows)
        .set({
          archivedAt: sql`clock_timestamp()`,
          archivedByActorId: actorId,
          updatedAt: sql`clock_timestamp()`,
        })
        .where(
          and(
            eq(maintenanceWindows.organizationId, organizationId),
            eq(maintenanceWindows.projectId, projectId),
            eq(maintenanceWindows.id, maintenanceWindowId),
          ),
        )
        .returning();
      if (!archived) throw new MaintenanceWindowNotFoundError();
      await tx.insert(maintenanceWindowAuditEvents).values({
        organizationId,
        projectId,
        maintenanceWindowId,
        action: 'ARCHIVED',
        versionNumber: window.currentVersionNumber,
        actorId,
      });
      return toRecord(archived, version, targetFor(version, targets.get(version.id) ?? []));
    });
  }

  async listAuditHistory(
    organizationId: string,
    projectId: string,
    maintenanceWindowId: string,
  ): Promise<MaintenanceWindowAuditRecord[]> {
    const exists = await this.findForProject(organizationId, projectId, maintenanceWindowId);
    if (!exists) throw new MaintenanceWindowNotFoundError();
    return this.db
      .select({
        id: maintenanceWindowAuditEvents.id,
        action: maintenanceWindowAuditEvents.action,
        versionNumber: maintenanceWindowAuditEvents.versionNumber,
        actorId: maintenanceWindowAuditEvents.actorId,
        occurredAt: maintenanceWindowAuditEvents.occurredAt,
      })
      .from(maintenanceWindowAuditEvents)
      .where(
        and(
          eq(maintenanceWindowAuditEvents.organizationId, organizationId),
          eq(maintenanceWindowAuditEvents.projectId, projectId),
          eq(maintenanceWindowAuditEvents.maintenanceWindowId, maintenanceWindowId),
        ),
      )
      .orderBy(asc(maintenanceWindowAuditEvents.occurredAt), asc(maintenanceWindowAuditEvents.id));
  }
}

async function insertVersion(
  tx: Transaction,
  window: MaintenanceWindowRow,
  actorId: string,
  input: MaintenanceWindowInput,
  action: Extract<MaintenanceWindowAction, 'CREATED' | 'UPDATED'>,
): Promise<MaintenanceWindowVersionRow> {
  const [version] = await tx
    .insert(maintenanceWindowVersions)
    .values({
      organizationId: window.organizationId,
      projectId: window.projectId,
      maintenanceWindowId: window.id,
      versionNumber: window.currentVersionNumber,
      name: input.name,
      schedule: input.schedule,
      targetType: input.target.type,
      effects: input.effects,
      createdByActorId: actorId,
    })
    .returning();
  if (!version) throw new Error('Maintenance window version creation returned no record.');
  if (input.target.type === 'MONITORS') {
    await tx.insert(maintenanceWindowVersionMonitors).values(
      input.target.monitorIds.map((monitorId) => ({
        organizationId: window.organizationId,
        projectId: window.projectId,
        maintenanceWindowVersionId: version.id,
        monitorId,
      })),
    );
  }
  await tx.insert(maintenanceWindowAuditEvents).values({
    organizationId: window.organizationId,
    projectId: window.projectId,
    maintenanceWindowId: window.id,
    action,
    versionNumber: window.currentVersionNumber,
    actorId,
  });
  return version;
}

async function assertProject(tx: Transaction, organizationId: string, projectId: string) {
  const [project] = await tx
    .select({ id: projects.id })
    .from(projects)
    .where(and(eq(projects.organizationId, organizationId), eq(projects.id, projectId)))
    .limit(1)
    .for('update');
  if (!project) throw new MaintenanceWindowProjectNotFoundError();
}

async function assertTargetMonitors(
  tx: Transaction,
  organizationId: string,
  projectId: string,
  target: MaintenanceWindowTarget,
) {
  if (target.type === 'PROJECT') return;
  const selected = await tx
    .select({ id: monitors.id })
    .from(monitors)
    .where(
      and(
        eq(monitors.organizationId, organizationId),
        eq(monitors.projectId, projectId),
        inArray(monitors.id, target.monitorIds),
      ),
    )
    .for('update');
  const found = new Set(selected.map(({ id }) => id));
  const invalid = target.monitorIds.filter((id) => !found.has(id));
  if (invalid.length > 0) throw new MaintenanceWindowTargetError(invalid);
}

async function lockWindow(
  tx: Transaction,
  organizationId: string,
  projectId: string,
  maintenanceWindowId: string,
) {
  const [window] = await tx
    .select()
    .from(maintenanceWindows)
    .where(
      and(
        eq(maintenanceWindows.organizationId, organizationId),
        eq(maintenanceWindows.projectId, projectId),
        eq(maintenanceWindows.id, maintenanceWindowId),
      ),
    )
    .limit(1)
    .for('update');
  if (!window) throw new MaintenanceWindowNotFoundError();
  return window;
}

async function loadTargets(
  db: WatchrailDatabase | Transaction,
  organizationId: string,
  versions: MaintenanceWindowVersionRow[],
) {
  const monitorVersionIds = versions
    .filter(({ targetType }) => targetType === 'MONITORS')
    .map(({ id }) => id);
  const targets = new Map<string, string[]>();
  if (monitorVersionIds.length === 0) return targets;
  const rows = await db
    .select({
      versionId: maintenanceWindowVersionMonitors.maintenanceWindowVersionId,
      monitorId: maintenanceWindowVersionMonitors.monitorId,
    })
    .from(maintenanceWindowVersionMonitors)
    .where(
      and(
        eq(maintenanceWindowVersionMonitors.organizationId, organizationId),
        inArray(maintenanceWindowVersionMonitors.maintenanceWindowVersionId, monitorVersionIds),
      ),
    )
    .orderBy(
      asc(maintenanceWindowVersionMonitors.maintenanceWindowVersionId),
      asc(maintenanceWindowVersionMonitors.monitorId),
    );
  for (const row of rows) {
    const monitorIds = targets.get(row.versionId) ?? [];
    monitorIds.push(row.monitorId);
    targets.set(row.versionId, monitorIds);
  }
  return targets;
}

function targetFor(version: MaintenanceWindowVersionRow, monitorIds: string[]) {
  return version.targetType === 'PROJECT'
    ? ({ type: 'PROJECT' } as const)
    : ({ type: 'MONITORS', monitorIds } as const);
}

function toRecord(
  window: MaintenanceWindowRow,
  version: MaintenanceWindowVersionRow,
  target: MaintenanceWindowTarget,
): MaintenanceWindowRecord {
  return {
    id: window.id,
    organizationId: window.organizationId,
    projectId: window.projectId,
    versionNumber: version.versionNumber,
    name: version.name,
    schedule: version.schedule,
    target,
    effects: version.effects,
    effectiveAt: version.effectiveAt,
    createdByActorId: window.createdByActorId,
    archivedAt: window.archivedAt,
    archivedByActorId: window.archivedByActorId,
    createdAt: window.createdAt,
    updatedAt: window.updatedAt,
  };
}
