import { and, asc, eq, inArray, ne, sql } from 'drizzle-orm';
import {
  availabilityStateForLifecycle,
  classifyAvailabilityObservation,
  isRoundNewer,
  type AvailabilityObservationInput,
  type MonitorLifecycleState,
} from '@watchrail/domain';
import type { WatchrailDatabase } from './client.js';
import { monitorAvailabilityState, monitors } from './schema.js';

type Transaction = Parameters<Parameters<WatchrailDatabase['transaction']>[0]>[0];
type AvailabilityState = typeof monitorAvailabilityState.$inferSelect;

export class AvailabilityRepository {
  constructor(private readonly db: WatchrailDatabase) {}

  async flushDue(batchSize: number, minimumAgeMs: number): Promise<number> {
    if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 1000) {
      throw new RangeError('Availability batch size must be an integer from 1 to 1000.');
    }
    if (!Number.isSafeInteger(minimumAgeMs) || minimumAgeMs <= 0) {
      throw new RangeError('Availability minimum age must be a positive safe integer.');
    }
    return this.db.transaction(async (tx) => {
      const rows = await tx
        .select({ state: monitorAvailabilityState })
        .from(monitorAvailabilityState)
        .innerJoin(
          monitors,
          and(
            eq(monitors.id, monitorAvailabilityState.monitorId),
            eq(monitors.organizationId, monitorAvailabilityState.organizationId),
          ),
        )
        .where(
          and(
            ne(monitors.lifecycleState, 'ARCHIVED'),
            sql`${monitorAvailabilityState.accountedThrough} <= clock_timestamp() - (${minimumAgeMs} * interval '1 millisecond')`,
          ),
        )
        .orderBy(
          asc(monitorAvailabilityState.accountedThrough),
          asc(monitorAvailabilityState.monitorId),
        )
        .limit(batchSize)
        .for('update', { of: monitorAvailabilityState, skipLocked: true });
      if (rows.length === 0) return 0;
      // Recheck the lifecycle in a fresh snapshot after the state locks are owned.
      // A lifecycle transaction could have committed during the initial claim statement.
      const eligible = new Set(
        (
          await tx
            .select({ id: monitors.id })
            .from(monitors)
            .where(
              and(
                inArray(
                  monitors.id,
                  rows.map((row) => row.state.monitorId),
                ),
                ne(monitors.lifecycleState, 'ARCHIVED'),
              ),
            )
        ).map((row) => row.id),
      );
      const flushAt = await acceptanceTime(tx);
      for (const { state } of rows) {
        if (eligible.has(state.monitorId)) await accrueAvailability(tx, state, flushAt);
      }
      return eligible.size;
    });
  }
}

export async function initializeAvailability(
  tx: Transaction,
  organizationId: string,
  monitorId: string,
  lifecycle: MonitorLifecycleState,
): Promise<void> {
  const at = await acceptanceTime(tx);
  await tx.insert(monitorAvailabilityState).values({
    organizationId,
    monitorId,
    currentState: availabilityStateForLifecycle(lifecycle),
    stateSince: at,
    accountedThrough: at,
    trackingStartedAt: at,
    enabledSince: lifecycle === 'ENABLED' ? at : null,
    updatedAt: at,
  });
}

export async function transitionAvailabilityLifecycle(
  tx: Transaction,
  organizationId: string,
  monitorId: string,
  lifecycle: MonitorLifecycleState,
): Promise<void> {
  const state = await lockAvailability(tx, organizationId, monitorId);
  const at = await acceptanceTime(tx);
  await accrueAvailability(tx, state, at);
  const currentState = availabilityStateForLifecycle(lifecycle);
  await tx
    .update(monitorAvailabilityState)
    .set({
      currentState,
      stateSince: currentState === state.currentState ? state.stateSince : at,
      enabledSince: lifecycle === 'ENABLED' ? at : null,
      updatedAt: at,
    })
    .where(eq(monitorAvailabilityState.monitorId, monitorId));
}

export async function applyAvailabilityObservation(
  tx: Transaction,
  round: { id: string; createdAt: Date; organizationId: string; monitorId: string },
  input: AvailabilityObservationInput,
): Promise<void> {
  const currentState = classifyAvailabilityObservation(input);
  if (currentState === null) return;
  const state = await lockAvailability(tx, round.organizationId, round.monitorId);
  if (
    state.currentState === 'EXCLUDED' ||
    !state.enabledSince ||
    round.createdAt < state.enabledSince ||
    round.createdAt < state.trackingStartedAt ||
    !isRoundNewer(
      { createdAt: round.createdAt, roundId: round.id },
      state.lastProcessedRoundCreatedAt && state.lastProcessedRoundId
        ? { createdAt: state.lastProcessedRoundCreatedAt, roundId: state.lastProcessedRoundId }
        : null,
    )
  )
    return;
  const at = await acceptanceTime(tx);
  await accrueAvailability(tx, state, at);
  await tx
    .update(monitorAvailabilityState)
    .set({
      currentState,
      stateSince: currentState === state.currentState ? state.stateSince : at,
      lastProcessedRoundCreatedAt: round.createdAt,
      lastProcessedRoundId: round.id,
      updatedAt: at,
    })
    .where(eq(monitorAvailabilityState.monitorId, round.monitorId));
}

async function lockAvailability(tx: Transaction, organizationId: string, monitorId: string) {
  const [state] = await tx
    .select()
    .from(monitorAvailabilityState)
    .where(
      and(
        eq(monitorAvailabilityState.organizationId, organizationId),
        eq(monitorAvailabilityState.monitorId, monitorId),
      ),
    )
    .limit(1)
    .for('update');
  if (!state) throw new Error('Monitor availability state is missing.');
  return state;
}

async function acceptanceTime(tx: Transaction): Promise<Date> {
  const result = await tx.execute<{ at: string }>(
    sql`select date_trunc('milliseconds', clock_timestamp()) as at`,
  );
  const at = result.rows[0]?.at;
  if (!at) throw new Error('Database availability clock is unavailable.');
  return new Date(at);
}

export async function accrueAvailability(
  tx: Transaction,
  state: AvailabilityState,
  at: Date,
): Promise<void> {
  if (at < state.accountedThrough)
    throw new Error('Availability accounting clock moved backwards.');
  if (at > state.accountedThrough) {
    // UTC timestamp arithmetic avoids session timezone and DST changes. Intervals are half-open.
    await tx.execute(sql`
      with buckets as (
        select day,
          (extract(epoch from (
            least(${at.toISOString()}::timestamptz at time zone 'UTC', day + interval '1 day')
            - greatest(${state.accountedThrough.toISOString()}::timestamptz at time zone 'UTC', day)
          )) * 1000)::integer as duration
        from generate_series(
          date_trunc('day', ${state.accountedThrough.toISOString()}::timestamptz at time zone 'UTC'),
          date_trunc('day', ${at.toISOString()}::timestamptz at time zone 'UTC'),
          interval '1 day'
        ) as day
      )
      insert into monitor_availability_daily
        (organization_id, monitor_id, day_utc, available_ms, unavailable_ms, unknown_ms, excluded_ms, updated_at)
      select ${state.organizationId}::uuid, ${state.monitorId}::uuid, day::date,
        case when ${state.currentState} = 'AVAILABLE' then duration else 0 end,
        case when ${state.currentState} = 'UNAVAILABLE' then duration else 0 end,
        case when ${state.currentState} = 'UNKNOWN' then duration else 0 end,
        case when ${state.currentState} = 'EXCLUDED' then duration else 0 end,
        ${at.toISOString()}::timestamptz
      from buckets where duration > 0
      on conflict (organization_id, monitor_id, day_utc) do update set
        available_ms = monitor_availability_daily.available_ms + excluded.available_ms,
        unavailable_ms = monitor_availability_daily.unavailable_ms + excluded.unavailable_ms,
        unknown_ms = monitor_availability_daily.unknown_ms + excluded.unknown_ms,
        excluded_ms = monitor_availability_daily.excluded_ms + excluded.excluded_ms,
        updated_at = excluded.updated_at
    `);
  }
  await tx
    .update(monitorAvailabilityState)
    .set({ accountedThrough: at, updatedAt: at })
    .where(eq(monitorAvailabilityState.monitorId, state.monitorId));
}
