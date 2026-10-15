import { eq, and } from 'drizzle-orm';
import { HTTP_ENGINE_VERSION, HTTP_EXECUTION_POLICY_VERSION } from '@watchrail/domain';
import { checkExecutionAssignments, checkRoundOutbox, probeLocations } from './schema.js';
import { createExecuteCheckRoundJob } from '@watchrail/contracts';
import type { WatchrailDatabase } from './client.js';

type Transaction = Parameters<Parameters<WatchrailDatabase['transaction']>[0]>[0];

export class MonitorLocationInvariantError extends Error {
  constructor() {
    super('Monitor execution location is invalid or unavailable.');
    this.name = 'MonitorLocationInvariantError';
  }
}

export async function createRoutedAssignment(
  tx: Transaction,
  input: { organizationId: string; roundId: string; locations: readonly string[] },
): Promise<void> {
  if (input.locations.length !== 1) throw new MonitorLocationInvariantError();
  const location = input.locations[0];
  if (!location) throw new MonitorLocationInvariantError();

  if (location === 'local') {
    await tx.insert(checkExecutionAssignments).values({
      organizationId: input.organizationId,
      roundId: input.roundId,
      location,
      status: 'PENDING',
    });
    await tx.insert(checkRoundOutbox).values({
      roundId: input.roundId,
      payload: createExecuteCheckRoundJob(input.roundId),
    });
    return;
  }

  const [remote] = await tx
    .select({ id: probeLocations.id })
    .from(probeLocations)
    .where(
      and(
        eq(probeLocations.organizationId, input.organizationId),
        eq(probeLocations.id, location),
      ),
    )
    .limit(1);
  if (!remote) throw new MonitorLocationInvariantError();

  await tx.insert(checkExecutionAssignments).values({
    organizationId: input.organizationId,
    roundId: input.roundId,
    location: remote.id,
    probeLocationId: remote.id,
    executionPolicyVersion: HTTP_EXECUTION_POLICY_VERSION,
    requiredEngineVersion: HTTP_ENGINE_VERSION,
    status: 'PENDING',
  });
}
