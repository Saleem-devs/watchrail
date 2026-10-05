import { and, eq, gte, lte, sql } from 'drizzle-orm';
import {
  deriveAvailabilityMetrics,
  intersectMeasurementWindow,
  nextUtcDayStart,
  utcDayStart,
  type AvailabilityDurations,
} from '@watchrail/domain';
import type { WatchrailDatabase } from './client.js';
import { monitorAvailabilityDaily, monitorAvailabilityState, monitors } from './schema.js';

export type UptimeWindow = 'TODAY' | 'LAST_7_DAYS' | 'LAST_30_DAYS';
export interface UptimeMetrics {
  window: { start: string; end: string };
  durations: AvailabilityDurations;
  uptimePercent: number | null;
  coveragePercent: number | null;
}
export interface DailyUptime extends UptimeMetrics {
  dayUtc: string;
}
export interface DailyUptimeProjection {
  window: UptimeMetrics['window'];
  days: DailyUptime[];
}
export class UptimeMonitorNotFoundError extends Error {
  constructor() {
    super('Monitor not found.');
  }
}
export class UptimeQueryError extends Error {
  constructor() {
    super('Use only window=today, window=7d, or window=30d.');
  }
}
export function parseUptimeQuery(
  query: Record<string, unknown>,
  fallback: UptimeWindow = 'LAST_7_DAYS',
): UptimeWindow {
  if (Object.keys(query).some((key) => key !== 'window')) throw new UptimeQueryError();
  if (query.window === undefined) return fallback;
  switch (query.window) {
    case 'today':
      return 'TODAY';
    case '7d':
      return 'LAST_7_DAYS';
    case '30d':
      return 'LAST_30_DAYS';
    default:
      throw new UptimeQueryError();
  }
}

export class UptimeReadRepository {
  constructor(private readonly db: WatchrailDatabase) {}
  async currentForOrganization(
    organizationId: string,
    window: UptimeWindow = 'LAST_7_DAYS',
  ): Promise<Map<string, UptimeMetrics>> {
    const projections = await this.read(organizationId, window);
    return new Map(projections.map(({ monitorId, summary }) => [monitorId, summary]));
  }
  async currentForMonitor(
    organizationId: string,
    monitorId: string,
    window: UptimeWindow = 'LAST_7_DAYS',
  ): Promise<UptimeMetrics> {
    const [projection] = await this.read(organizationId, window, monitorId);
    if (!projection) throw new UptimeMonitorNotFoundError();
    return projection.summary;
  }
  async dailyForMonitor(
    organizationId: string,
    monitorId: string,
    window: UptimeWindow = 'LAST_30_DAYS',
  ): Promise<DailyUptimeProjection> {
    const [projection] = await this.read(organizationId, window, monitorId, true);
    if (!projection) throw new UptimeMonitorNotFoundError();
    return { window: projection.summary.window, days: projection.days };
  }
  private async read(
    organizationId: string,
    window: UptimeWindow,
    monitorId?: string,
    includeDaily = false,
  ) {
    const days =
      window === 'TODAY' ? 1 : window === 'LAST_7_DAYS' ? 7 : window === 'LAST_30_DAYS' ? 30 : null;
    if (days === null) throw new UptimeQueryError();
    return this.db.transaction(
      async (tx) => {
        // This first SELECT establishes the MVCC snapshot and one request-wide cutoff.
        // No row locks, flushes, or other writes are permitted in this transaction.
        const clock = await tx.execute<{ cutoff: string }>(
          sql`select date_trunc('milliseconds', clock_timestamp()) as cutoff`,
        );
        const cutoff = new Date(clock.rows[0]!.cutoff);
        const start = utcDayStart(cutoff);
        start.setUTCDate(start.getUTCDate() - (days - 1));
        const states = await tx
          .select({ monitorId: monitors.id, state: monitorAvailabilityState })
          .from(monitors)
          .leftJoin(
            monitorAvailabilityState,
            and(
              eq(monitors.id, monitorAvailabilityState.monitorId),
              eq(monitors.organizationId, monitorAvailabilityState.organizationId),
            ),
          )
          .where(
            and(
              eq(monitors.organizationId, organizationId),
              monitorId ? eq(monitors.id, monitorId) : undefined,
            ),
          );
        const scope = and(
          eq(monitorAvailabilityDaily.organizationId, organizationId),
          monitorId ? eq(monitorAvailabilityDaily.monitorId, monitorId) : undefined,
          gte(monitorAvailabilityDaily.dayUtc, dayKey(start)),
          lte(monitorAvailabilityDaily.dayUtc, dayKey(cutoff)),
        );
        const daily = includeDaily
          ? await tx.select().from(monitorAvailabilityDaily).where(scope)
          : [];
        // Compact list/detail reads aggregate in PostgreSQL, not a daily-series payload.
        const totals = includeDaily
          ? []
          : await tx
              .select({
                monitorId: monitorAvailabilityDaily.monitorId,
                availableMs: sql`sum(${monitorAvailabilityDaily.availableMs})`.mapWith(Number),
                unavailableMs: sql`sum(${monitorAvailabilityDaily.unavailableMs})`.mapWith(Number),
                unknownMs: sql`sum(${monitorAvailabilityDaily.unknownMs})`.mapWith(Number),
                excludedMs: sql`sum(${monitorAvailabilityDaily.excludedMs})`.mapWith(Number),
              })
              .from(monitorAvailabilityDaily)
              .where(scope)
              .groupBy(monitorAvailabilityDaily.monitorId);
        const totalsByMonitor = new Map(
          totals.map(({ monitorId: id, ...duration }) => [id, duration]),
        );
        const byMonitor = new Map<string, Map<string, AvailabilityDurations>>();
        for (const row of daily) {
          let buckets = byMonitor.get(row.monitorId);
          if (!buckets) {
            buckets = new Map();
            byMonitor.set(row.monitorId, buckets);
          }
          buckets.set(row.dayUtc, {
            availableMs: row.availableMs,
            unavailableMs: row.unavailableMs,
            unknownMs: row.unknownMs,
            excludedMs: row.excludedMs,
          });
        }
        return states.map(({ monitorId: id, state }) => {
          if (!state) throw new Error('Monitor availability state is missing.');
          if (state.accountedThrough > cutoff || state.trackingStartedAt > cutoff)
            throw new Error('Availability accounting clock is ahead of the query cutoff.');
          const measurement =
            start < cutoff
              ? intersectMeasurementWindow(start, cutoff, state.trackingStartedAt)
              : null;
          const measuredStart = measurement?.start ?? cutoff;
          const series: DailyUptime[] = [];
          const field = {
            AVAILABLE: 'availableMs',
            UNAVAILABLE: 'unavailableMs',
            UNKNOWN: 'unknownMs',
            EXCLUDED: 'excludedMs',
          } as const;
          if (!includeDaily) {
            const duration = { ...(totalsByMonitor.get(id) ?? emptyDurations()) };
            duration[field[state.currentState]] += Math.max(
              0,
              cutoff.getTime() -
                Math.max(measuredStart.getTime(), state.accountedThrough.getTime()),
            );
            return {
              monitorId: id,
              summary: metrics(measuredStart, cutoff, duration),
              days: series,
            };
          }
          const durations = emptyDurations();
          for (let day = utcDayStart(measuredStart); day < cutoff; day = nextUtcDayStart(day)) {
            const bucketStart = new Date(Math.max(day.getTime(), measuredStart.getTime()));
            const bucketEnd = new Date(Math.min(nextUtcDayStart(day).getTime(), cutoff.getTime()));
            if (bucketStart >= bucketEnd) continue;
            const bucket = { ...(byMonitor.get(id)?.get(dayKey(day)) ?? emptyDurations()) };
            const tailStart = Math.max(bucketStart.getTime(), state.accountedThrough.getTime());
            const tailMs = Math.max(0, bucketEnd.getTime() - tailStart);
            bucket[field[state.currentState]] += tailMs;
            for (const key of Object.keys(durations) as Array<keyof AvailabilityDurations>)
              durations[key] += bucket[key];
            series.push({ dayUtc: dayKey(day), ...metrics(bucketStart, bucketEnd, bucket) });
          }
          return {
            monitorId: id,
            summary: metrics(measuredStart, cutoff, durations),
            days: series,
          };
        });
      },
      { isolationLevel: 'repeatable read', accessMode: 'read only' },
    );
  }
}
function emptyDurations(): AvailabilityDurations {
  return { availableMs: 0, unavailableMs: 0, unknownMs: 0, excludedMs: 0 };
}
function dayKey(day: Date): string {
  return day.toISOString().slice(0, 10);
}
function metrics(start: Date, end: Date, durations: AvailabilityDurations): UptimeMetrics {
  const { uptimePercent, coveragePercent } = deriveAvailabilityMetrics(durations);
  return {
    window: { start: start.toISOString(), end: end.toISOString() },
    durations,
    uptimePercent,
    coveragePercent,
  };
}
