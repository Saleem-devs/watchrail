import { sql } from 'drizzle-orm';
import type { WatchrailDatabase } from './client.js';

type Transaction = Parameters<Parameters<WatchrailDatabase['transaction']>[0]>[0];

export async function roundIsFencedByManualResolution(
  tx: Transaction,
  input: {
    organizationId: string;
    monitorId: string;
    roundId: string;
  },
): Promise<boolean> {
  const result = await tx.execute<{ predatesResolution: boolean }>(sql`
    select exists (
      select 1
      from check_rounds round
      join incidents incident
        on incident.organization_id=round.organization_id
        and incident.monitor_id=round.monitor_id
      where round.organization_id=${input.organizationId}::uuid
        and round.monitor_id=${input.monitorId}::uuid
        and round.id=${input.roundId}::uuid
        and incident.resolved_by_actor_id is not null
        and incident.resolved_at >= round.created_at
    ) as "predatesResolution"
  `);
  const row = result.rows[0];
  if (!row) throw new Error('Incident round ordering state is missing.');
  return row.predatesResolution;
}
