// packages/db/src/monitor-repository.ts

import { randomUUID } from 'node:crypto';
import { and, desc, eq, ne, sql } from 'drizzle-orm';
import {
  EMPTY_ASSERTION_CONFIGURATION,
  assertAssertionsCompatibleWithMethod,
  parseStoredAssertionConfiguration,
  type ResponseAssertionConfigurationV1,
  type HttpMonitorSettings,
  type HttpMonitorMethod,
  type HttpStatusPolicy,
  type NewMonitor,
  type MonitorLifecycleState,
  type StoredRequestHeader,
} from '@watchrail/domain';
import type { WatchrailDatabase } from './client.js';
import {
  initializeAvailability,
  transitionAvailabilityLifecycle,
} from './availability-repository.js';
import {
  monitorConfigurationVersions,
  monitorIncidentState,
  monitors,
  type MonitorRecord,
} from './schema.js';

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
          intervalSeconds: monitor.intervalSeconds,
          nextCheckAt: sql`clock_timestamp() + (${monitor.intervalSeconds} * interval '1 second')`,
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
        intervalSeconds: created.intervalSeconds,
        followRedirects: created.followRedirects,
        statusPolicy: created.statusPolicy,
        requestHeaders: created.requestHeaders,
        assertions: created.assertions,
        locations: created.locations,
      });

      await tx.insert(monitorIncidentState).values({
        organizationId,
        monitorId: created.id,
        trackingStartedAt: sql`clock_timestamp()`,
      });
      await initializeAvailability(tx, organizationId, created.id, created.lifecycleState);

      return created;
    });
  }

  async listForOrganization(organizationId: string): Promise<MonitorRecord[]> {
    return this.db
      .select()
      .from(monitors)
      .where(
        and(eq(monitors.organizationId, organizationId), ne(monitors.lifecycleState, 'ARCHIVED')),
      )
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
        intervalSeconds: configuration.intervalSeconds,
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
        intervalSeconds: configuration.intervalSeconds,
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
        intervalSeconds: configuration.intervalSeconds,
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
        intervalSeconds: configuration.intervalSeconds,
        followRedirects: configuration.followRedirects,
        statusPolicy: configuration.statusPolicy,
        requestHeaders: configuration.requestHeaders,
        assertions,
        locations: configuration.locations,
      });
      return updated;
    });
  }

  async updateScheduleSettings(
    organizationId: string,
    monitorId: string,
    intervalSeconds: number,
  ): Promise<MonitorRecord> {
    return this.db.transaction(async (tx) => {
      const [monitor] = await tx
        .select()
        .from(monitors)
        .where(and(eq(monitors.id, monitorId), eq(monitors.organizationId, organizationId)))
        .limit(1)
        .for('update');
      if (!monitor) throw new MonitorUpdateNotFoundError();

      if (monitor.intervalSeconds === intervalSeconds) return monitor;

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
        .set({
          intervalSeconds,
          nextCheckAt:
            monitor.lifecycleState === 'ENABLED'
              ? sql`clock_timestamp() + (${intervalSeconds} * interval '1 second')`
              : null,
          updatedAt: sql`clock_timestamp()`,
        })
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
        intervalSeconds,
        followRedirects: configuration.followRedirects,
        statusPolicy: configuration.statusPolicy,
        requestHeaders: configuration.requestHeaders,
        assertions: configuration.assertions,
        locations: configuration.locations,
      });
      return updated;
    });
  }

  async updateLifecycle(
    organizationId: string,
    monitorId: string,
    lifecycleState: MonitorLifecycleState,
  ): Promise<MonitorRecord> {
    return this.db.transaction(async (tx) => {
      const [monitor] = await tx
        .select()
        .from(monitors)
        .where(and(eq(monitors.id, monitorId), eq(monitors.organizationId, organizationId)))
        .limit(1)
        // Daily-row inserts acquire a foreign-key KEY SHARE lock on this monitor.
        // Do not hold a conflicting UPDATE lock while waiting for availability state.
        .for('no key update');
      if (!monitor) throw new MonitorUpdateNotFoundError();
      if (monitor.lifecycleState === 'ARCHIVED' && lifecycleState !== 'ARCHIVED') {
        throw new ArchivedMonitorLifecycleError();
      }
      if (monitor.lifecycleState === lifecycleState) return monitor;

      await transitionAvailabilityLifecycle(tx, organizationId, monitorId, lifecycleState);

      const [updated] = await tx
        .update(monitors)
        .set({
          lifecycleState,
          nextCheckAt:
            lifecycleState === 'ENABLED'
              ? sql`clock_timestamp() + (${monitor.intervalSeconds} * interval '1 second')`
              : null,
          updatedAt: sql`clock_timestamp()`,
        })
        .where(and(eq(monitors.id, monitorId), eq(monitors.organizationId, organizationId)))
        .returning();
      if (!updated) throw new Error('The monitor update returned no record.');
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

export class ArchivedMonitorLifecycleError extends Error {
  constructor() {
    super('Archived monitors cannot change lifecycle state.');
    this.name = 'ArchivedMonitorLifecycleError';
  }
}
