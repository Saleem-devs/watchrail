// packages/db/src/monitor-repository.ts

import { randomUUID } from 'node:crypto';
import { and, desc, eq, sql } from 'drizzle-orm';
import type { HttpStatusPolicy, NewMonitor, StoredRequestHeader } from '@watchrail/domain';
import type { WatchrailDatabase } from './client.js';
import { monitorConfigurationVersions, monitors, type MonitorRecord } from './schema.js';

export class MonitorRepository {
  constructor(private readonly db: WatchrailDatabase) {}

  async create(
    organizationId: string,
    monitorOrId: NewMonitor | string,
    suppliedMonitor?: NewMonitor,
    suppliedRequestHeaders: StoredRequestHeader[] = [],
  ): Promise<MonitorRecord> {
    const monitorId = typeof monitorOrId === 'string' ? monitorOrId : randomUUID();
    const monitor = typeof monitorOrId === 'string' ? suppliedMonitor : monitorOrId;
    if (!monitor) throw new Error('Monitor data is required.');
    const requestHeaders = typeof monitorOrId === 'string' ? suppliedRequestHeaders : [];

    return this.db.transaction(async (tx) => {
      const [created] = await tx
        .insert(monitors)
        .values({
          id: monitorId,
          organizationId,
          name: monitor.name,
          url: monitor.url,
          method: monitor.method,
          lifecycleState: monitor.lifecycleState,
          timeoutMs: monitor.timeoutMs,
          statusPolicy: monitor.statusPolicy,
          requestHeaders,
          locations: monitor.locations,
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
        requestHeaders: created.requestHeaders,
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
        requestHeaders: configuration.requestHeaders,
        locations: configuration.locations,
      });

      return updated;
    });
  }

  async updateRequestHeaders(
    organizationId: string,
    monitorId: string,
    update: (current: readonly StoredRequestHeader[]) => StoredRequestHeader[],
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
      const requestHeaders = update(configuration.requestHeaders);

      const [updated] = await tx
        .update(monitors)
        .set({ requestHeaders, updatedAt: sql`now()` })
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
        statusPolicy: configuration.statusPolicy,
        requestHeaders,
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
