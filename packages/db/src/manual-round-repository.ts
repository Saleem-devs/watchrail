import { and, desc, eq } from 'drizzle-orm';
import type { CheckRoundOutboxPayload, MonitorLifecycleState } from '@watchrail/domain';
import type { WatchrailDatabase } from './client.js';
import {
  checkExecutionAssignments,
  checkRoundOutbox,
  checkRounds,
  monitorConfigurationVersions,
  monitors,
  type CheckRoundRecord,
} from './schema.js';

export class MonitorNotFoundError extends Error {
  constructor() {
    super('Monitor not found.');
    this.name = 'MonitorNotFoundError';
  }
}

export class MonitorNotRunnableError extends Error {
  readonly lifecycleState: MonitorLifecycleState;

  constructor(lifecycleState: MonitorLifecycleState) {
    super(`Monitor cannot run while lifecycle state is ${lifecycleState}.`);

    this.name = 'MonitorNotRunnableError';
    this.lifecycleState = lifecycleState;
  }
}

export class MonitorConfigurationInvariantError extends Error {
  constructor() {
    super('Monitor has no configuration version.');
    this.name = 'MonitorConfigurationInvariantError';
  }
}

export class ManualRoundRepository {
  constructor(private readonly db: WatchrailDatabase) {}

  async create(organizationId: string, monitorId: string): Promise<CheckRoundRecord> {
    return this.db.transaction(async (tx) => {
      /*
       * Lock the monitor row.
       *
       * Any future configuration-update transaction should acquire this
       * same lock before appending its next configuration version. That gives
       * round creation a stable definition of "current configuration".
       */
      const [monitor] = await tx
        .select({
          id: monitors.id,
          lifecycleState: monitors.lifecycleState,
        })
        .from(monitors)
        .where(and(eq(monitors.id, monitorId), eq(monitors.organizationId, organizationId)))
        .limit(1)
        .for('update');

      if (!monitor) {
        throw new MonitorNotFoundError();
      }

      if (monitor.lifecycleState !== 'ENABLED') {
        throw new MonitorNotRunnableError(monitor.lifecycleState);
      }

      /*
       * Configuration versions are append-only.
       * Highest version_number is the current configuration.
       */
      const [configuration] = await tx
        .select({
          id: monitorConfigurationVersions.id,
        })
        .from(monitorConfigurationVersions)
        .where(
          and(
            eq(monitorConfigurationVersions.organizationId, organizationId),
            eq(monitorConfigurationVersions.monitorId, monitorId),
          ),
        )
        .orderBy(desc(monitorConfigurationVersions.versionNumber))
        .limit(1);

      if (!configuration) {
        throw new MonitorConfigurationInvariantError();
      }

      const [round] = await tx
        .insert(checkRounds)
        .values({
          organizationId,
          monitorId,

          monitorConfigurationVersionId: configuration.id,

          trigger: 'MANUAL',
          status: 'PENDING',
        })
        .returning();

      if (!round) {
        throw new Error('The check round insert returned no record.');
      }

      await tx.insert(checkExecutionAssignments).values({
        organizationId,
        roundId: round.id,

        location: 'local',
        status: 'PENDING',
      });

      const payload = {
        contractVersion: 1,
        roundId: round.id,
      } satisfies CheckRoundOutboxPayload;

      await tx.insert(checkRoundOutbox).values({
        roundId: round.id,
        payload,
      });

      return round;
    });
  }
}
