import { and, asc, desc, eq, lte, sql } from 'drizzle-orm';
import {
  MULTI_LOCATION_AGGREGATION_POLICY_VERSION,
  MULTI_LOCATION_CONFIRMATION_POLICY_VERSION,
  MULTI_LOCATION_CONTRACT_VERSION,
  MULTI_LOCATION_ROUND_FINALIZATION_WINDOW_MS,
} from '@watchrail/domain';
import type { WatchrailDatabase } from './client.js';
import {
  checkRounds,
  monitorConfigurationVersions,
  monitors,
  type CheckRoundRecord,
} from './schema.js';
import { createRoundLocationSnapshot, createRoutedAssignment } from './round-routing.js';

export class ScheduledRoundRepository {
  constructor(
    private readonly db: WatchrailDatabase,
    private readonly multiLocationExecutionEnabled = false,
  ) {}

  async dispatchDue(batchSize: number): Promise<CheckRoundRecord[]> {
    assertBatchSize(batchSize);

    return this.db.transaction(async (tx) => {
      const due = await tx
        .select({
          id: monitors.id,
          organizationId: monitors.organizationId,
          intervalSeconds: monitors.intervalSeconds,
        })
        .from(monitors)
        .where(
          and(
            eq(monitors.lifecycleState, 'ENABLED'),
            lte(monitors.nextCheckAt, sql`clock_timestamp()`),
          ),
        )
        .orderBy(asc(monitors.nextCheckAt), asc(monitors.id))
        .limit(batchSize)
        .for('update', { skipLocked: true });

      const rounds: CheckRoundRecord[] = [];

      for (const monitor of due) {
        const [configuration] = await tx
          .select({
            id: monitorConfigurationVersions.id,
            locations: monitorConfigurationVersions.locations,
          })
          .from(monitorConfigurationVersions)
          .where(
            and(
              eq(monitorConfigurationVersions.organizationId, monitor.organizationId),
              eq(monitorConfigurationVersions.monitorId, monitor.id),
            ),
          )
          .orderBy(desc(monitorConfigurationVersions.versionNumber))
          .limit(1);

        if (!configuration) {
          throw new Error(`Due monitor ${monitor.id} has no configuration version.`);
        }

        const [round] = await tx
          .insert(checkRounds)
          .values({
            organizationId: monitor.organizationId,
            monitorId: monitor.id,
            monitorConfigurationVersionId: configuration.id,
            trigger: 'SCHEDULED',
            status: 'PENDING',
            contractVersion: MULTI_LOCATION_CONTRACT_VERSION,
            aggregationPolicyVersion: MULTI_LOCATION_AGGREGATION_POLICY_VERSION,
            confirmationPolicyVersion: MULTI_LOCATION_CONFIRMATION_POLICY_VERSION,
            finalizationDeadlineAt: sql`clock_timestamp() + (${MULTI_LOCATION_ROUND_FINALIZATION_WINDOW_MS} * interval '1 millisecond')`,
          })
          .returning();
        if (!round) throw new Error('The scheduled check-round insert returned no record.');

        const locations = await createRoundLocationSnapshot(tx, {
          organizationId: monitor.organizationId,
          roundId: round.id,
          locations: configuration.locations,
        });
        await createRoutedAssignment(tx, {
          organizationId: monitor.organizationId,
          roundId: round.id,
          locations,
          multiLocationExecutionEnabled: this.multiLocationExecutionEnabled,
        });

        await tx
          .update(monitors)
          .set({
            nextCheckAt: sql`clock_timestamp() + (${monitor.intervalSeconds} * interval '1 second')`,
          })
          .where(
            and(eq(monitors.organizationId, monitor.organizationId), eq(monitors.id, monitor.id)),
          );

        rounds.push(round);
      }

      return rounds;
    });
  }
}

function assertBatchSize(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > 1_000) {
    throw new RangeError('Scheduled dispatch batch size must be an integer from 1 to 1000.');
  }
}
