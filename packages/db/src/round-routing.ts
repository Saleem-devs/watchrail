import { eq, and, inArray } from 'drizzle-orm';
import {
  HTTP_ENGINE_VERSION,
  HTTP_EXECUTION_POLICY_VERSION,
  normalizeLocationSnapshot,
} from '@watchrail/domain';
import {
  checkExecutionAssignments,
  checkRoundLocations,
  checkRoundOutbox,
  probeLocations,
} from './schema.js';
import { createExecuteCheckRoundJob } from '@watchrail/contracts';
import type { WatchrailDatabase } from './client.js';

type Transaction = Parameters<Parameters<WatchrailDatabase['transaction']>[0]>[0];

export class MonitorLocationInvariantError extends Error {
  constructor() {
    super('Monitor execution location is invalid or unavailable.');
    this.name = 'MonitorLocationInvariantError';
  }
}

export async function createRoundLocationSnapshot(
  tx: Transaction,
  input: { organizationId: string; roundId: string; locations: readonly string[] },
): Promise<readonly string[]> {
  const locations = normalizeLocationSnapshot(input.locations);
  const remoteLocationIds = locations.filter((location) => location !== 'local');
  if (remoteLocationIds.length > 0) {
    const remoteLocations = await tx
      .select({ id: probeLocations.id })
      .from(probeLocations)
      .where(
        and(
          eq(probeLocations.organizationId, input.organizationId),
          inArray(probeLocations.id, remoteLocationIds),
        ),
      );
    if (remoteLocations.length !== remoteLocationIds.length) {
      throw new MonitorLocationInvariantError();
    }
  }

  await tx.insert(checkRoundLocations).values(
    locations.map((location, position) => ({
      organizationId: input.organizationId,
      roundId: input.roundId,
      location,
      probeLocationId: location === 'local' ? null : location,
      position,
    })),
  );
  return locations;
}

export async function createRoutedAssignment(
  tx: Transaction,
  input: {
    organizationId: string;
    roundId: string;
    locations: readonly string[];
    multiLocationExecutionEnabled?: boolean;
  },
): Promise<void> {
  if (input.locations.length !== 1 && input.multiLocationExecutionEnabled !== true) {
    throw new MonitorLocationInvariantError();
  }
  // Slice 11.4 activates independent remote agents first. A local participant
  // still uses the single-location worker path until it can emit regional evidence.
  if (input.locations.length > 1 && input.locations.includes('local')) {
    throw new MonitorLocationInvariantError();
  }
  await createPreparedRoutedAssignments(tx, input);
}

/**
 * Stage-B routing primitive. Round creation intentionally does not call this for
 * multi-location snapshots until aggregate finalization replaces first-result
 * round completion.
 */
export async function createPreparedRoutedAssignments(
  tx: Transaction,
  input: { organizationId: string; roundId: string; locations: readonly string[] },
): Promise<void> {
  const locations = normalizeLocationSnapshot(input.locations);
  const remoteLocationIds = locations.filter((location) => location !== 'local');
  if (remoteLocationIds.length > 0) {
    const remoteLocations = await tx
      .select({ id: probeLocations.id })
      .from(probeLocations)
      .where(
        and(
          eq(probeLocations.organizationId, input.organizationId),
          inArray(probeLocations.id, remoteLocationIds),
        ),
      );
    if (remoteLocations.length !== remoteLocationIds.length) {
      throw new MonitorLocationInvariantError();
    }
  }

  await tx.insert(checkExecutionAssignments).values(
    locations.map((location) => ({
      organizationId: input.organizationId,
      roundId: input.roundId,
      location,
      probeLocationId: location === 'local' ? null : location,
      executionPolicyVersion: HTTP_EXECUTION_POLICY_VERSION,
      requiredEngineVersion: HTTP_ENGINE_VERSION,
      status: 'PENDING' as const,
    })),
  );

  if (locations.includes('local')) {
    await tx.insert(checkRoundOutbox).values({
      roundId: input.roundId,
      payload: createExecuteCheckRoundJob(input.roundId),
    });
  }
}
