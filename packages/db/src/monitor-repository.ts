// packages/db/src/monitor-repository.ts

import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, inArray, ne, sql } from 'drizzle-orm';
import {
  EMPTY_ASSERTION_CONFIGURATION,
  MonitorInputError,
  assertAssertionsCompatibleWithMethod,
  normalizeLocationSnapshot,
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
  probeLocations,
  projects,
  type MonitorRecord,
} from './schema.js';
import { ensureDefaultProject } from './project-repository.js';

export class MonitorRepository {
  constructor(private readonly db: WatchrailDatabase) {}

  async create(
    organizationId: string,
    monitorOrId: NewMonitor | string,
    suppliedMonitor?: NewMonitor,
    suppliedRequestHeaders: StoredRequestHeader[] = [],
    suppliedAssertions: ResponseAssertionConfigurationV1 = EMPTY_ASSERTION_CONFIGURATION,
    suppliedProjectId?: string,
  ): Promise<MonitorRecord> {
    const monitorId = typeof monitorOrId === 'string' ? monitorOrId : randomUUID();
    const monitor = typeof monitorOrId === 'string' ? suppliedMonitor : monitorOrId;
    if (!monitor) throw new Error('Monitor data is required.');
    const requestHeaders = typeof monitorOrId === 'string' ? suppliedRequestHeaders : [];
    const assertions =
      typeof monitorOrId === 'string' ? suppliedAssertions : EMPTY_ASSERTION_CONFIGURATION;
    const projectId = suppliedProjectId ?? (await ensureDefaultProject(this.db, organizationId)).id;

    return this.db.transaction(async (tx) => {
      const [created] = await tx
        .insert(monitors)
        .values({
          id: monitorId,
          organizationId,
          projectId,
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
          requestBody: monitor.requestBody,
          assertions,
          tlsPolicy: monitor.tlsPolicy,
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
        requestBody: created.requestBody,
        assertions: created.assertions,
        tlsPolicy: created.tlsPolicy,
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

  async listForProject(organizationId: string, projectId: string): Promise<MonitorRecord[]> {
    return this.db
      .select()
      .from(monitors)
      .where(
        and(
          eq(monitors.organizationId, organizationId),
          eq(monitors.projectId, projectId),
          ne(monitors.lifecycleState, 'ARCHIVED'),
        ),
      )
      .orderBy(desc(monitors.createdAt));
  }

  async findForProject(
    organizationId: string,
    projectId: string,
    monitorId: string,
  ): Promise<MonitorRecord | null> {
    const [monitor] = await this.db
      .select()
      .from(monitors)
      .where(
        and(
          eq(monitors.organizationId, organizationId),
          eq(monitors.projectId, projectId),
          eq(monitors.id, monitorId),
          ne(monitors.lifecycleState, 'ARCHIVED'),
        ),
      )
      .limit(1);
    return monitor ?? null;
  }

  async belongsToProject(
    organizationId: string,
    projectId: string,
    monitorId: string,
  ): Promise<boolean> {
    const [row] = await this.db
      .select({ id: monitors.id })
      .from(monitors)
      .innerJoin(
        projects,
        and(
          eq(projects.organizationId, monitors.organizationId),
          eq(projects.id, monitors.projectId),
        ),
      )
      .where(
        and(
          eq(monitors.organizationId, organizationId),
          eq(monitors.projectId, projectId),
          eq(monitors.id, monitorId),
        ),
      )
      .limit(1);
    return Boolean(row);
  }

  async updateName(
    organizationId: string,
    monitorId: string,
    name: string,
  ): Promise<MonitorRecord> {
    const [updated] = await this.db
      .update(monitors)
      .set({ name, updatedAt: sql`now()` })
      .where(and(eq(monitors.id, monitorId), eq(monitors.organizationId, organizationId)))
      .returning();

    if (!updated) throw new MonitorUpdateNotFoundError();
    return updated;
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
        requestBody: configuration.requestBody,
        assertions: configuration.assertions,
        tlsPolicy: configuration.tlsPolicy,
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
        requestBody: configuration.requestBody,
        assertions: configuration.assertions,
        tlsPolicy: configuration.tlsPolicy,
        locations: configuration.locations,
      });

      return updated;
    });
  }

  async updateConfiguration(
    organizationId: string,
    monitorId: string,
    settings: HttpMonitorSettings,
    updateRequestHeaders: (current: readonly StoredRequestHeader[]) => StoredRequestHeader[],
    updateAssertions: (
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

      const tlsPolicy = settings.tlsPolicy ?? configuration.tlsPolicy;
      assertTlsPolicyUrlCompatibility(tlsPolicy, settings.url);

      const requestHeaders = updateRequestHeaders(configuration.requestHeaders);
      const assertions = updateAssertions(
        parseStoredAssertionConfiguration(configuration.assertions),
        settings.method,
      );
      assertAssertionsCompatibleWithMethod(settings.method, assertions.assertions);

      const [updated] = await tx
        .update(monitors)
        .set({
          ...settings,
          tlsPolicy,
          requestHeaders,
          assertions,
          updatedAt: sql`now()`,
        })
        .where(and(eq(monitors.id, monitorId), eq(monitors.organizationId, organizationId)))
        .returning();
      if (!updated) throw new Error('The monitor update returned no record.');

      await tx.insert(monitorConfigurationVersions).values({
        organizationId,
        monitorId,
        versionNumber: configuration.versionNumber + 1,
        ...settings,
        tlsPolicy,
        intervalSeconds: configuration.intervalSeconds,
        statusPolicy: configuration.statusPolicy,
        requestHeaders,
        assertions,
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

      const tlsPolicy = settings.tlsPolicy ?? configuration.tlsPolicy;
      assertTlsPolicyUrlCompatibility(tlsPolicy, settings.url);

      const assertions = parseStoredAssertionConfiguration(configuration.assertions).assertions;
      assertAssertionsCompatibleWithMethod(settings.method, assertions);

      const [updated] = await tx
        .update(monitors)
        .set({ ...settings, tlsPolicy, updatedAt: sql`now()` })
        .where(and(eq(monitors.id, monitorId), eq(monitors.organizationId, organizationId)))
        .returning();

      if (!updated) throw new Error('The monitor update returned no record.');

      await tx.insert(monitorConfigurationVersions).values({
        organizationId,
        monitorId,
        versionNumber: configuration.versionNumber + 1,
        ...settings,
        tlsPolicy,
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
      if (!isHttpMonitorMethod(configuration.method)) {
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
        requestBody: configuration.requestBody,
        assertions,
        tlsPolicy: configuration.tlsPolicy,
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
        requestBody: configuration.requestBody,
        assertions: configuration.assertions,
        tlsPolicy: configuration.tlsPolicy,
        locations: configuration.locations,
      });
      return updated;
    });
  }

  async updateLocations(
    organizationId: string,
    monitorId: string,
    requestedLocations: readonly string[],
  ): Promise<MonitorRecord> {
    return this.db.transaction(async (tx) => {
      const [monitor] = await tx
        .select()
        .from(monitors)
        .where(and(eq(monitors.id, monitorId), eq(monitors.organizationId, organizationId)))
        .limit(1)
        .for('update');
      if (!monitor) throw new MonitorUpdateNotFoundError();

      const locations = normalizeLocationSnapshot(requestedLocations);
      const remoteLocationIds = locations.filter((location) => location !== 'local');
      if (remoteLocationIds.length > 0) {
        const remote = await tx
          .select({ id: probeLocations.id })
          .from(probeLocations)
          .where(
            and(
              eq(probeLocations.organizationId, organizationId),
              inArray(probeLocations.id, remoteLocationIds),
              eq(probeLocations.status, 'ACTIVE'),
            ),
          )
          .orderBy(asc(probeLocations.id))
          .for('key share');
        if (remote.length !== remoteLocationIds.length) {
          throw new MonitorLocationUnavailableError();
        }
      }

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
      if (
        configuration.locations.length === locations.length &&
        configuration.locations.every((location, index) => location === locations[index])
      ) {
        return monitor;
      }

      const [updated] = await tx
        .update(monitors)
        .set({ locations: [...locations], updatedAt: sql`clock_timestamp()` })
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
        requestBody: configuration.requestBody,
        assertions: configuration.assertions,
        tlsPolicy: configuration.tlsPolicy,
        locations: [...locations],
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

function assertTlsPolicyUrlCompatibility(policy: { type: string }, url: string): void {
  if (policy.type !== 'DISABLED' && !url.startsWith('https://')) {
    throw new MonitorInputError({
      tlsPolicy: ['Certificate expiry monitoring requires an HTTPS URL.'],
    });
  }
}

function isHttpMonitorMethod(method: string): method is HttpMonitorMethod {
  return (
    method === 'GET' ||
    method === 'HEAD' ||
    method === 'POST' ||
    method === 'PUT' ||
    method === 'PATCH' ||
    method === 'DELETE' ||
    method === 'OPTIONS'
  );
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

export class MonitorLocationUnavailableError extends Error {
  constructor() {
    super('Remote probe location is unavailable.');
    this.name = 'MonitorLocationUnavailableError';
  }
}
