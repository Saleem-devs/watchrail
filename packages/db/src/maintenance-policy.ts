import { and, asc, eq, inArray } from 'drizzle-orm';
import {
  maintenanceOccurrenceAt,
  maintenanceOccurrencesBetween,
  mergeMaintenanceEffects,
  type MaintenanceOccurrence,
  type MaintenanceWindowEffects,
  type MaintenanceWindowSchedule,
} from '@watchrail/domain';
import type { WatchrailDatabase } from './client.js';
import {
  maintenanceWindows,
  maintenanceWindowVersionMonitors,
  maintenanceWindowVersions,
  monitors,
} from './schema.js';

export interface ActiveMaintenanceWindow {
  id: string;
  name: string;
  versionNumber: number;
  occurrence: MaintenanceOccurrence;
  effects: MaintenanceWindowEffects;
}

export interface ActiveMaintenancePolicy {
  active: boolean;
  effects: MaintenanceWindowEffects;
  windows: ActiveMaintenanceWindow[];
}

export interface MaintenanceExclusionInterval {
  startsAt: Date;
  endsAt: Date;
}

interface VersionSlice {
  id: string;
  maintenanceWindowId: string;
  versionNumber: number;
  name: string;
  schedule: MaintenanceWindowSchedule;
  targetType: string;
  effects: MaintenanceWindowEffects;
  startsAt: Date;
  endsAt: Date | null;
}

interface PolicyRows {
  slices: VersionSlice[];
  monitorIdsByVersion: Map<string, Set<string>>;
}

type Transaction = Parameters<Parameters<WatchrailDatabase['transaction']>[0]>[0];
type DatabaseReader = WatchrailDatabase | Transaction;

export class MaintenancePolicyRepository {
  constructor(private readonly db: DatabaseReader) {}

  async activeForMonitor(
    organizationId: string,
    projectId: string,
    monitorId: string,
    at: Date,
  ): Promise<ActiveMaintenancePolicy> {
    const rows = await loadPolicyRows(this.db, organizationId, projectId);
    const windows = rows.slices.flatMap<ActiveMaintenanceWindow>((slice) => {
      if (!sliceContains(slice, at) || !targetsMonitor(slice, rows, monitorId)) return [];
      const occurrence = maintenanceOccurrenceAt(slice.schedule, at);
      if (!occurrence) return [];
      return [
        {
          id: slice.maintenanceWindowId,
          name: slice.name,
          versionNumber: slice.versionNumber,
          occurrence,
          effects: slice.effects,
        },
      ];
    });
    return {
      active: windows.length > 0,
      effects: mergeMaintenanceEffects(windows.map(({ effects }) => effects)),
      windows,
    };
  }

  async activeForProject(
    organizationId: string,
    projectId: string,
    at: Date,
  ): Promise<Map<string, ActiveMaintenancePolicy>> {
    const rows = await loadPolicyRows(this.db, organizationId, projectId);
    const policies = new Map<string, ActiveMaintenanceWindow[]>();
    for (const slice of rows.slices) {
      if (!sliceContains(slice, at)) continue;
      const occurrence = maintenanceOccurrenceAt(slice.schedule, at);
      if (!occurrence) continue;
      const window: ActiveMaintenanceWindow = {
        id: slice.maintenanceWindowId,
        name: slice.name,
        versionNumber: slice.versionNumber,
        occurrence,
        effects: slice.effects,
      };
      if (slice.targetType === 'PROJECT') {
        const projectWindows = policies.get('*') ?? [];
        projectWindows.push(window);
        policies.set('*', projectWindows);
        continue;
      }
      for (const monitorId of rows.monitorIdsByVersion.get(slice.id) ?? []) {
        const monitorWindows = policies.get(monitorId) ?? [];
        monitorWindows.push(window);
        policies.set(monitorId, monitorWindows);
      }
    }
    return new Map(
      [...policies].map(([monitorId, windows]) => [
        monitorId,
        {
          active: windows.length > 0,
          effects: mergeMaintenanceEffects(windows.map(({ effects }) => effects)),
          windows,
        },
      ]),
    );
  }

  async exclusionIntervalsForMonitor(
    organizationId: string,
    projectId: string,
    monitorId: string,
    from: Date,
    to: Date,
  ): Promise<MaintenanceExclusionInterval[]> {
    return maintenanceExclusionIntervals(this.db, organizationId, projectId, monitorId, from, to);
  }
}

export async function activeMaintenancePolicyForMonitor(
  db: DatabaseReader,
  organizationId: string,
  monitorId: string,
  at: Date,
): Promise<ActiveMaintenancePolicy> {
  const [monitor] = await db
    .select({ projectId: monitors.projectId })
    .from(monitors)
    .where(and(eq(monitors.organizationId, organizationId), eq(monitors.id, monitorId)))
    .limit(1);
  if (!monitor) throw new Error('Maintenance policy monitor is missing.');
  return new MaintenancePolicyRepository(db).activeForMonitor(
    organizationId,
    monitor.projectId,
    monitorId,
    at,
  );
}

export async function maintenanceExclusionIntervals(
  db: DatabaseReader,
  organizationId: string,
  projectId: string,
  monitorId: string,
  from: Date,
  to: Date,
): Promise<MaintenanceExclusionInterval[]> {
  if (to <= from) return [];
  // Version effective times and archival boundaries are prospective policy edges.
  // Materialized availability buckets are never rewritten; callers use these slices
  // only for the still-unaccounted interval that begins at accountedThrough.
  const rows = await loadPolicyRows(db, organizationId, projectId);
  const intervals = rows.slices.flatMap<MaintenanceExclusionInterval>((slice) => {
    if (!slice.effects.excludeFromUptime || !targetsMonitor(slice, rows, monitorId)) return [];
    const sliceFrom = maxDate(from, slice.startsAt);
    const sliceTo = minDate(to, slice.endsAt ?? to);
    if (sliceTo <= sliceFrom) return [];
    return maintenanceOccurrencesBetween(slice.schedule, sliceFrom, sliceTo).map((occurrence) => ({
      startsAt: maxDate(sliceFrom, occurrence.startsAt),
      endsAt: minDate(sliceTo, occurrence.endsAt),
    }));
  });
  return mergeIntervals(intervals);
}

async function loadPolicyRows(
  db: DatabaseReader,
  organizationId: string,
  projectId: string,
): Promise<PolicyRows> {
  const rows = await db
    .select({ window: maintenanceWindows, version: maintenanceWindowVersions })
    .from(maintenanceWindows)
    .innerJoin(
      maintenanceWindowVersions,
      and(
        eq(maintenanceWindowVersions.organizationId, maintenanceWindows.organizationId),
        eq(maintenanceWindowVersions.projectId, maintenanceWindows.projectId),
        eq(maintenanceWindowVersions.maintenanceWindowId, maintenanceWindows.id),
      ),
    )
    .where(
      and(
        eq(maintenanceWindows.organizationId, organizationId),
        eq(maintenanceWindows.projectId, projectId),
      ),
    )
    .orderBy(
      asc(maintenanceWindows.id),
      asc(maintenanceWindowVersions.versionNumber),
      asc(maintenanceWindowVersions.id),
    );
  const slices: VersionSlice[] = rows.map(({ window, version }, index) => {
    const next = rows[index + 1];
    const nextEffectiveAt =
      next?.window.id === window.id ? next.version.effectiveAt : window.archivedAt;
    return {
      id: version.id,
      maintenanceWindowId: window.id,
      versionNumber: version.versionNumber,
      name: version.name,
      schedule: version.schedule,
      targetType: version.targetType,
      effects: version.effects,
      startsAt: version.effectiveAt,
      endsAt: minNullableDate(nextEffectiveAt ?? null, window.archivedAt),
    };
  });
  const selectedVersionIds = slices
    .filter(({ targetType }) => targetType === 'MONITORS')
    .map(({ id }) => id);
  const monitorIdsByVersion = new Map<string, Set<string>>();
  if (selectedVersionIds.length > 0) {
    const targets = await db
      .select({
        versionId: maintenanceWindowVersionMonitors.maintenanceWindowVersionId,
        monitorId: maintenanceWindowVersionMonitors.monitorId,
      })
      .from(maintenanceWindowVersionMonitors)
      .where(
        and(
          eq(maintenanceWindowVersionMonitors.organizationId, organizationId),
          eq(maintenanceWindowVersionMonitors.projectId, projectId),
          inArray(maintenanceWindowVersionMonitors.maintenanceWindowVersionId, selectedVersionIds),
        ),
      );
    for (const target of targets) {
      const monitorIds = monitorIdsByVersion.get(target.versionId) ?? new Set<string>();
      monitorIds.add(target.monitorId);
      monitorIdsByVersion.set(target.versionId, monitorIds);
    }
  }
  return { slices, monitorIdsByVersion };
}

function targetsMonitor(slice: VersionSlice, rows: PolicyRows, monitorId: string) {
  return (
    slice.targetType === 'PROJECT' ||
    rows.monitorIdsByVersion.get(slice.id)?.has(monitorId) === true
  );
}

function sliceContains(slice: VersionSlice, at: Date) {
  return slice.startsAt <= at && (slice.endsAt === null || at < slice.endsAt);
}

function mergeIntervals(intervals: MaintenanceExclusionInterval[]) {
  const sorted = [...intervals].sort(
    (left, right) => left.startsAt.getTime() - right.startsAt.getTime(),
  );
  const merged: MaintenanceExclusionInterval[] = [];
  for (const interval of sorted) {
    const previous = merged.at(-1);
    if (!previous || previous.endsAt < interval.startsAt) {
      merged.push({ ...interval });
      continue;
    }
    if (interval.endsAt > previous.endsAt) previous.endsAt = interval.endsAt;
  }
  return merged;
}

function maxDate(left: Date, right: Date) {
  return left > right ? left : right;
}

function minDate(left: Date, right: Date) {
  return left < right ? left : right;
}

function minNullableDate(left: Date | null, right: Date | null) {
  if (left === null) return right;
  if (right === null) return left;
  return minDate(left, right);
}
