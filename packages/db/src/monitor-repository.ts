// packages/db/src/monitor-repository.ts

import { and, desc, eq, sql } from 'drizzle-orm';
import type { HttpStatusPolicy, NewMonitor } from '@watchrail/domain';
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
        statusPolicy: created.statusPolicy,
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

  async updateStatusPolicy(
    organizationId: string,
    monitorId: string,
    statusPolicy: HttpStatusPolicy,
  ): Promise<MonitorRecord> {
    return this.db.transaction(async (tx) => {
      const [monitor] = await tx
        .select()
        .from(monitors)
        .where(and(eq(monitors.id, monitorId), eq(monitors.organizationId, organizationId)))
        .limit(1)
        .for('update');

      if (!monitor) throw new MonitorUpdateNotFoundError();

      const [configuration] = await tx
        .select()
        .from(monitorConfigurationVersions)
        .where(
          and(
            eq(monitorConfigurationVersions.monitorId, monitorId),
            eq(monitorConfigurationVersions.organizationId, organizationId),
          ),
        )
        .orderBy(desc(monitorConfigurationVersions.versionNumber))
        .limit(1);

      if (!configuration) throw new Error('Monitor has no configuration version.');

      const [updated] = await tx
        .update(monitors)
        .set({ statusPolicy, updatedAt: sql`now()` })
        .where(and(eq(monitors.id, monitorId), eq(monitors.organizationId, organizationId)))
        .returning();

      if (!updated) throw new Error('The monitor update returned no record.');

      await tx.insert(monitorConfigurationVersions).values({
        organizationId,
        monitorId,
        versionNumber: configuration.versionNumber + 1,
        url: configuration.url,
        method: configuration.method,
        timeoutMs: configuration.timeoutMs,
        statusPolicy,
        locations: configuration.locations,
      });

      return updated;
    });
  }
}

export class MonitorUpdateNotFoundError extends Error {
  constructor() {
    super('Monitor not found.');
    this.name = 'MonitorUpdateNotFoundError';
  }
}
