// packages/db/src/monitor-repository.ts

import { desc, eq } from 'drizzle-orm';
import type { NewMonitor } from '@watchrail/domain';
import type { WatchrailDatabase } from './client.js';
import { monitorConfigurationVersions, monitors, type MonitorRecord } from './schema.js';

export class MonitorRepository {
  constructor(private readonly db: WatchrailDatabase) {}

  async create(organizationId: string, monitor: NewMonitor): Promise<MonitorRecord> {
    return this.db.transaction(async (tx) => {
      const [created] = await tx
        .insert(monitors)
        .values({
          organizationId,
          ...monitor,
        })
        .returning();

      if (!created) {
        throw new Error('The monitor insert returned no record.');
      }

      await tx.insert(monitorConfigurationVersions).values({
        organizationId,
        monitorId: created.id,
        versionNumber: 1,

        url: created.url,
        method: created.method,
        timeoutMs: created.timeoutMs,
        locations: created.locations,
      });

      return created;
    });
  }

  async listForOrganization(organizationId: string): Promise<MonitorRecord[]> {
    return this.db
      .select()
      .from(monitors)
      .where(eq(monitors.organizationId, organizationId))
      .orderBy(desc(monitors.createdAt));
  }
}
