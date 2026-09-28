// packages/db/src/monitor-repository.ts

import { randomUUID } from 'node:crypto';
import { and, desc, eq, sql } from 'drizzle-orm';
import {
  EMPTY_ASSERTION_CONFIGURATION,
  assertAssertionsCompatibleWithMethod,
  parseStoredAssertionConfiguration,
  type ResponseAssertionConfigurationV1,
  type HttpMonitorSettings,
  type HttpMonitorMethod,
  type HttpStatusPolicy,
  type NewMonitor,
  type StoredRequestHeader,
} from '@watchrail/domain';
import type { WatchrailDatabase } from './client.js';
import { monitorConfigurationVersions, monitors, type MonitorRecord } from './schema.js';

export class MonitorRepository {
  constructor(private readonly db: WatchrailDatabase) {}

  async create(
    organizationId: string,
    monitorOrId: NewMonitor | string,
    suppliedMonitor?: NewMonitor,
    suppliedRequestHeaders: StoredRequestHeader[] = [],
    suppliedAssertions: ResponseAssertionConfigurationV1 = EMPTY_ASSERTION_CONFIGURATION,
  ): Promise<MonitorRecord> {
    const monitorId = typeof monitorOrId === 'string' ? monitorOrId : randomUUID();
    const monitor = typeof monitorOrId === 'string' ? suppliedMonitor : monitorOrId;
    if (!monitor) throw new Error('Monitor data is required.');
    const requestHeaders = typeof monitorOrId === 'string' ? suppliedRequestHeaders : [];
    const assertions =
      typeof monitorOrId === 'string' ? suppliedAssertions : EMPTY_ASSERTION_CONFIGURATION;

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
          followRedirects: monitor.followRedirects,
          statusPolicy: monitor.statusPolicy,
          requestHeaders,
          assertions,
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
        followRedirects: created.followRedirects,
        statusPolicy: created.statusPolicy,
        requestHeaders: created.requestHeaders,
        assertions: created.assertions,
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
        followRedirects: configuration.followRedirects,
        statusPolicy,
        requestHeaders: configuration.requestHeaders,
        assertions: configuration.assertions,
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
        followRedirects: configuration.followRedirects,
        statusPolicy: configuration.statusPolicy,
        requestHeaders,
        assertions: configuration.assertions,
        locations: configuration.locations,
      });

      return updated;
    });
  }

  async updateHttpSettings(
    organizationId: string,
    monitorId: string,
    settings: HttpMonitorSettings,
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

      const assertions = parseStoredAssertionConfiguration(configuration.assertions).assertions;
      assertAssertionsCompatibleWithMethod(settings.method, assertions);

      const [updated] = await tx
        .update(monitors)
        .set({ ...settings, updatedAt: sql`now()` })
        .where(and(eq(monitors.id, monitorId), eq(monitors.organizationId, organizationId)))
        .returning();

      if (!updated) throw new Error('The monitor update returned no record.');

      await tx.insert(monitorConfigurationVersions).values({
        organizationId,
        monitorId,
        versionNumber: configuration.versionNumber + 1,
        ...settings,
        statusPolicy: configuration.statusPolicy,
        requestHeaders: configuration.requestHeaders,
        assertions: configuration.assertions,
        locations: configuration.locations,
      });

      return updated;
    });
  }

  async updateAssertions(
    organizationId: string,
    monitorId: string,
    update: (
      current: ResponseAssertionConfigurationV1,
      method: HttpMonitorMethod,
    ) => ResponseAssertionConfigurationV1,
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
      if (configuration.method !== 'GET' && configuration.method !== 'HEAD') {
        throw new Error('Response assertions require a supported HTTP monitor method.');
      }

      const assertions = update(
        parseStoredAssertionConfiguration(configuration.assertions),
        configuration.method,
      );
      const [updated] = await tx
        .update(monitors)
        .set({ assertions, updatedAt: sql`now()` })
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
        followRedirects: configuration.followRedirects,
        statusPolicy: configuration.statusPolicy,
        requestHeaders: configuration.requestHeaders,
        assertions,
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
