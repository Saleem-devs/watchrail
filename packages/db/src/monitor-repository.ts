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
  type StoredHeaderAssertion,
  type StoredJsonBodyAssertion,
  type StoredTextBodyAssertion,
  type HttpMonitorSettings,
  type HttpMonitorMethod,
  type HttpStatusPolicy,
  type NewMonitor,
  type MonitorLifecycleState,
  type StoredRequestHeader,
  type TcpMonitorSettings,
  type DnsMonitorSettings,
  type StoredApiWorkflowConfigurationV1,
  type HeartbeatMonitorSettings,
  type DomainExpiryMonitorSettings,
  type IcmpMonitorSettings,
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
  workspaceSecretBindings,
  workspaceSecrets,
  type MonitorRecord,
} from './schema.js';
import { ensureDefaultProject } from './project-repository.js';
import { assertWorkspaceSecretUseAuthorized } from './workspace-secret-use-policy.js';
import { nextHeartbeatDeadline } from './heartbeat-schedule.js';

export class MonitorRepository {
  constructor(private readonly db: WatchrailDatabase) {}

  async create(
    organizationId: string,
    monitorOrId: NewMonitor | string,
    suppliedMonitor?: NewMonitor,
    suppliedRequestHeaders: StoredRequestHeader[] = [],
    suppliedAssertions: ResponseAssertionConfigurationV1 = EMPTY_ASSERTION_CONFIGURATION,
    suppliedProjectId?: string,
    suppliedApiWorkflow?: StoredApiWorkflowConfigurationV1,
    heartbeatTokenHash?: string,
  ): Promise<MonitorRecord> {
    const monitorId = typeof monitorOrId === 'string' ? monitorOrId : randomUUID();
    const monitor = typeof monitorOrId === 'string' ? suppliedMonitor : monitorOrId;
    if (!monitor) throw new Error('Monitor data is required.');
    const requestHeaders = typeof monitorOrId === 'string' ? suppliedRequestHeaders : [];
    const assertions =
      typeof monitorOrId === 'string' ? suppliedAssertions : EMPTY_ASSERTION_CONFIGURATION;
    const projectId = suppliedProjectId ?? (await ensureDefaultProject(this.db, organizationId)).id;
    const apiWorkflow = monitor.type === 'API_WORKFLOW' ? suppliedApiWorkflow : null;
    if (monitor.type === 'API_WORKFLOW' && !apiWorkflow) {
      throw new Error('Stored API workflow configuration is required.');
    }
    if (monitor.type === 'HEARTBEAT' && !heartbeatTokenHash) {
      throw new Error('Heartbeat credential hash is required.');
    }
    const heartbeatDeadline =
      monitor.type === 'HEARTBEAT'
        ? nextHeartbeatDeadline(monitor.heartbeat.schedule, new Date())
        : null;

    return this.db.transaction(async (tx) => {
      const [created] = await tx
        .insert(monitors)
        .values({
          id: monitorId,
          organizationId,
          projectId,
          name: monitor.name,
          type: monitor.type,
          tcpHost: monitor.type === 'TCP' ? monitor.host : null,
          tcpPort: monitor.type === 'TCP' ? monitor.port : null,
          icmpHost: monitor.type === 'ICMP' ? monitor.host : null,
          dnsName: monitor.type === 'DNS' ? monitor.dnsName : null,
          dnsRecordType: monitor.type === 'DNS' ? monitor.dnsRecordType : null,
          dnsExpectedValues: monitor.type === 'DNS' ? monitor.dnsExpectedValues : [],
          domainName: monitor.type === 'DOMAIN_EXPIRY' ? monitor.domainName : null,
          domainWarningDays: monitor.type === 'DOMAIN_EXPIRY' ? monitor.domainWarningDays : null,
          apiWorkflow,
          heartbeat: monitor.type === 'HEARTBEAT' ? monitor.heartbeat : null,
          heartbeatTokenHash: monitor.type === 'HEARTBEAT' ? heartbeatTokenHash : null,
          url: monitor.type === 'HTTP' ? monitor.url : '',
          method: monitor.type === 'HTTP' ? monitor.method : 'GET',
          lifecycleState: monitor.lifecycleState,
          timeoutMs: monitor.timeoutMs,
          intervalSeconds: monitor.intervalSeconds,
          nextCheckAt:
            monitor.lifecycleState === 'ENABLED'
              ? monitor.type === 'HEARTBEAT'
                ? heartbeatDeadline
                : sql`clock_timestamp() + (${monitor.intervalSeconds} * interval '1 second')`
              : null,
          followRedirects: monitor.type === 'HTTP' ? monitor.followRedirects : false,
          statusPolicy:
            monitor.type === 'HTTP' ? monitor.statusPolicy : { type: 'ANY_2XX' as const },
          requestHeaders,
          requestBody: monitor.type === 'HTTP' ? monitor.requestBody : { type: 'NONE' as const },
          assertions,
          tlsPolicy: monitor.type === 'HTTP' ? monitor.tlsPolicy : { type: 'DISABLED' as const },
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
        type: created.type,
        tcpHost: created.tcpHost,
        tcpPort: created.tcpPort,
        icmpHost: created.icmpHost,
        dnsName: created.dnsName,
        dnsRecordType: created.dnsRecordType,
        dnsExpectedValues: created.dnsExpectedValues,
        domainName: created.domainName,
        domainWarningDays: created.domainWarningDays,
        apiWorkflow: created.apiWorkflow,
        heartbeat: created.heartbeat,

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
      await reconcileWorkspaceSecretBindings(
        tx,
        organizationId,
        created.id,
        created.requestHeaders,
        created.assertions,
        created.apiWorkflow,
      );

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

  async findForOrganization(
    organizationId: string,
    monitorId: string,
  ): Promise<MonitorRecord | null> {
    const [monitor] = await this.db
      .select()
      .from(monitors)
      .where(
        and(
          eq(monitors.organizationId, organizationId),
          eq(monitors.id, monitorId),
          ne(monitors.lifecycleState, 'ARCHIVED'),
        ),
      )
      .limit(1);
    return monitor ?? null;
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
      if (monitor.type !== 'HTTP') throw new MonitorProtocolMismatchError('HTTP');

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
        type: configuration.type,
        tcpHost: configuration.tcpHost,
        tcpPort: configuration.tcpPort,
        icmpHost: configuration.icmpHost,
        dnsName: configuration.dnsName,
        dnsRecordType: configuration.dnsRecordType,
        dnsExpectedValues: configuration.dnsExpectedValues,
        apiWorkflow: configuration.apiWorkflow,
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
      if (monitor.type !== 'HTTP') throw new MonitorProtocolMismatchError('HTTP');

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
        type: configuration.type,
        tcpHost: configuration.tcpHost,
        tcpPort: configuration.tcpPort,
        icmpHost: configuration.icmpHost,
        dnsName: configuration.dnsName,
        dnsRecordType: configuration.dnsRecordType,
        dnsExpectedValues: configuration.dnsExpectedValues,
        apiWorkflow: configuration.apiWorkflow,
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
      await reconcileWorkspaceSecretBindings(
        tx,
        organizationId,
        monitorId,
        requestHeaders,
        configuration.assertions,
        configuration.apiWorkflow,
      );

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
    workspaceSecretUseAuthorized = true,
  ): Promise<MonitorRecord> {
    return this.db.transaction(async (tx) => {
      const [monitor] = await tx
        .select()
        .from(monitors)
        .where(and(eq(monitors.id, monitorId), eq(monitors.organizationId, organizationId)))
        .limit(1)
        .for('update');
      if (!monitor) throw new MonitorUpdateNotFoundError();
      if (monitor.type !== 'HTTP') throw new MonitorProtocolMismatchError('HTTP');

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
      assertWorkspaceSecretUseAuthorized(
        {
          requestHeaders,
          assertions,
          apiWorkflow: configuration.apiWorkflow,
        },
        workspaceSecretUseAuthorized,
      );

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
        type: configuration.type,
        tcpHost: configuration.tcpHost,
        tcpPort: configuration.tcpPort,
        icmpHost: configuration.icmpHost,
        dnsName: configuration.dnsName,
        dnsRecordType: configuration.dnsRecordType,
        dnsExpectedValues: configuration.dnsExpectedValues,
        apiWorkflow: configuration.apiWorkflow,
        ...settings,
        tlsPolicy,
        intervalSeconds: configuration.intervalSeconds,
        statusPolicy: configuration.statusPolicy,
        requestHeaders,
        assertions,
        locations: configuration.locations,
      });
      await reconcileWorkspaceSecretBindings(
        tx,
        organizationId,
        monitorId,
        requestHeaders,
        assertions,
        configuration.apiWorkflow,
      );
      return updated;
    });
  }

  async updateHttpSettings(
    organizationId: string,
    monitorId: string,
    settings: HttpMonitorSettings,
    workspaceSecretUseAuthorized = true,
  ): Promise<MonitorRecord> {
    return this.db.transaction(async (tx) => {
      const [monitor] = await tx
        .select()
        .from(monitors)
        .where(and(eq(monitors.id, monitorId), eq(monitors.organizationId, organizationId)))
        .limit(1)
        .for('update');

      if (!monitor) throw new MonitorUpdateNotFoundError();
      if (monitor.type !== 'HTTP') throw new MonitorProtocolMismatchError('HTTP');
      assertWorkspaceSecretUseAuthorized(monitor, workspaceSecretUseAuthorized);

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
        type: configuration.type,
        tcpHost: configuration.tcpHost,
        tcpPort: configuration.tcpPort,
        icmpHost: configuration.icmpHost,
        dnsName: configuration.dnsName,
        dnsRecordType: configuration.dnsRecordType,
        dnsExpectedValues: configuration.dnsExpectedValues,
        apiWorkflow: configuration.apiWorkflow,
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

  async updateTcpSettings(
    organizationId: string,
    monitorId: string,
    settings: TcpMonitorSettings,
  ): Promise<MonitorRecord> {
    return this.db.transaction(async (tx) => {
      const [monitor] = await tx
        .select()
        .from(monitors)
        .where(and(eq(monitors.id, monitorId), eq(monitors.organizationId, organizationId)))
        .limit(1)
        .for('update');
      if (!monitor) throw new MonitorUpdateNotFoundError();
      if (monitor.type !== 'TCP') throw new MonitorProtocolMismatchError('TCP');

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
          tcpHost: settings.host,
          tcpPort: settings.port,
          timeoutMs: settings.timeoutMs,
          updatedAt: sql`now()`,
        })
        .where(and(eq(monitors.id, monitorId), eq(monitors.organizationId, organizationId)))
        .returning();
      if (!updated) throw new Error('The monitor update returned no record.');

      await tx.insert(monitorConfigurationVersions).values({
        organizationId,
        monitorId,
        versionNumber: configuration.versionNumber + 1,
        type: 'TCP',
        tcpHost: settings.host,
        tcpPort: settings.port,
        apiWorkflow: configuration.apiWorkflow,
        url: configuration.url,
        method: configuration.method,
        timeoutMs: settings.timeoutMs,
        intervalSeconds: configuration.intervalSeconds,
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

  async updateIcmpSettings(
    organizationId: string,
    monitorId: string,
    settings: IcmpMonitorSettings,
  ): Promise<MonitorRecord> {
    return this.db.transaction(async (tx) => {
      const [monitor] = await tx
        .select()
        .from(monitors)
        .where(and(eq(monitors.id, monitorId), eq(monitors.organizationId, organizationId)))
        .limit(1)
        .for('update');
      if (!monitor) throw new MonitorUpdateNotFoundError();
      if (monitor.type !== 'ICMP') throw new MonitorProtocolMismatchError('ICMP');

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
        .set({ icmpHost: settings.host, timeoutMs: settings.timeoutMs, updatedAt: sql`now()` })
        .where(and(eq(monitors.id, monitorId), eq(monitors.organizationId, organizationId)))
        .returning();
      if (!updated) throw new Error('The monitor update returned no record.');

      await tx.insert(monitorConfigurationVersions).values({
        organizationId,
        monitorId,
        versionNumber: configuration.versionNumber + 1,
        type: 'ICMP',
        icmpHost: settings.host,
        url: configuration.url,
        method: configuration.method,
        timeoutMs: settings.timeoutMs,
        intervalSeconds: configuration.intervalSeconds,
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

  async updateDnsSettings(
    organizationId: string,
    monitorId: string,
    settings: DnsMonitorSettings,
  ): Promise<MonitorRecord> {
    return this.db.transaction(async (tx) => {
      const [monitor] = await tx
        .select()
        .from(monitors)
        .where(and(eq(monitors.id, monitorId), eq(monitors.organizationId, organizationId)))
        .limit(1)
        .for('update');
      if (!monitor) throw new MonitorUpdateNotFoundError();
      if (monitor.type !== 'DNS') throw new MonitorProtocolMismatchError('DNS');

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
          dnsName: settings.name,
          dnsRecordType: settings.recordType,
          dnsExpectedValues: settings.expectedValues,
          timeoutMs: settings.timeoutMs,
          updatedAt: sql`now()`,
        })
        .where(and(eq(monitors.id, monitorId), eq(monitors.organizationId, organizationId)))
        .returning();
      if (!updated) throw new Error('The monitor update returned no record.');

      await tx.insert(monitorConfigurationVersions).values({
        organizationId,
        monitorId,
        versionNumber: configuration.versionNumber + 1,
        type: 'DNS',
        tcpHost: null,
        tcpPort: null,
        dnsName: settings.name,
        dnsRecordType: settings.recordType,
        dnsExpectedValues: settings.expectedValues,
        apiWorkflow: configuration.apiWorkflow,
        url: configuration.url,
        method: configuration.method,
        timeoutMs: settings.timeoutMs,
        intervalSeconds: configuration.intervalSeconds,
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

  async updateDomainExpirySettings(
    organizationId: string,
    monitorId: string,
    settings: DomainExpiryMonitorSettings,
  ): Promise<MonitorRecord> {
    return this.db.transaction(async (tx) => {
      const [monitor] = await tx
        .select()
        .from(monitors)
        .where(and(eq(monitors.id, monitorId), eq(monitors.organizationId, organizationId)))
        .limit(1)
        .for('update');
      if (!monitor) throw new MonitorUpdateNotFoundError();
      if (monitor.type !== 'DOMAIN_EXPIRY') throw new MonitorProtocolMismatchError('DOMAIN_EXPIRY');
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
          domainName: settings.domainName,
          domainWarningDays: settings.warningDays,
          timeoutMs: settings.timeoutMs,
          updatedAt: sql`now()`,
        })
        .where(and(eq(monitors.id, monitorId), eq(monitors.organizationId, organizationId)))
        .returning();
      if (!updated) throw new Error('The monitor update returned no record.');
      await tx.insert(monitorConfigurationVersions).values({
        organizationId,
        monitorId,
        versionNumber: configuration.versionNumber + 1,
        type: 'DOMAIN_EXPIRY',
        domainName: settings.domainName,
        domainWarningDays: settings.warningDays,
        url: configuration.url,
        method: configuration.method,
        timeoutMs: settings.timeoutMs,
        intervalSeconds: configuration.intervalSeconds,
        followRedirects: configuration.followRedirects,
        statusPolicy: configuration.statusPolicy,
        requestHeaders: configuration.requestHeaders,
        requestBody: configuration.requestBody,
        assertions: configuration.assertions,
        tlsPolicy: configuration.tlsPolicy,
        locations: ['local'],
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
      if (monitor.type !== 'HTTP') throw new MonitorProtocolMismatchError('HTTP');

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
        type: configuration.type,
        tcpHost: configuration.tcpHost,
        tcpPort: configuration.tcpPort,
        icmpHost: configuration.icmpHost,
        dnsName: configuration.dnsName,
        dnsRecordType: configuration.dnsRecordType,
        dnsExpectedValues: configuration.dnsExpectedValues,
        apiWorkflow: configuration.apiWorkflow,
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
      await reconcileWorkspaceSecretBindings(
        tx,
        organizationId,
        monitorId,
        configuration.requestHeaders,
        assertions,
        configuration.apiWorkflow,
      );
      return updated;
    });
  }

  async updateApiWorkflow(
    organizationId: string,
    monitorId: string,
    update: (current: StoredApiWorkflowConfigurationV1) => StoredApiWorkflowConfigurationV1,
    workspaceSecretUseAuthorized = true,
  ): Promise<MonitorRecord> {
    return this.db.transaction(async (tx) => {
      const [monitor] = await tx
        .select()
        .from(monitors)
        .where(and(eq(monitors.id, monitorId), eq(monitors.organizationId, organizationId)))
        .limit(1)
        .for('update');
      if (!monitor) throw new MonitorUpdateNotFoundError();
      if (monitor.type !== 'API_WORKFLOW') {
        throw new MonitorProtocolMismatchError('API_WORKFLOW');
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
      if (!configuration.apiWorkflow) throw new Error('Monitor has no API workflow configuration.');

      const apiWorkflow = update(configuration.apiWorkflow);
      assertWorkspaceSecretUseAuthorized(
        {
          requestHeaders: configuration.requestHeaders,
          assertions: parseStoredAssertionConfiguration(configuration.assertions),
          apiWorkflow,
        },
        workspaceSecretUseAuthorized,
      );
      const timeoutMs = Math.max(...apiWorkflow.steps.map((step) => step.timeoutMs));
      const [updated] = await tx
        .update(monitors)
        .set({ apiWorkflow, timeoutMs, updatedAt: sql`clock_timestamp()` })
        .where(and(eq(monitors.id, monitorId), eq(monitors.organizationId, organizationId)))
        .returning();
      if (!updated) throw new Error('The monitor update returned no record.');

      await tx.insert(monitorConfigurationVersions).values({
        organizationId,
        monitorId,
        versionNumber: configuration.versionNumber + 1,
        type: 'API_WORKFLOW',
        tcpHost: null,
        tcpPort: null,
        dnsName: null,
        dnsRecordType: null,
        dnsExpectedValues: [],
        apiWorkflow,
        url: configuration.url,
        method: configuration.method,
        timeoutMs,
        intervalSeconds: configuration.intervalSeconds,
        followRedirects: configuration.followRedirects,
        statusPolicy: configuration.statusPolicy,
        requestHeaders: configuration.requestHeaders,
        requestBody: configuration.requestBody,
        assertions: configuration.assertions,
        tlsPolicy: configuration.tlsPolicy,
        locations: configuration.locations,
      });
      await reconcileWorkspaceSecretBindings(
        tx,
        organizationId,
        monitorId,
        configuration.requestHeaders,
        configuration.assertions,
        apiWorkflow,
      );
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
      if (monitor.type === 'HEARTBEAT') {
        throw new MonitorProtocolMismatchError('HTTP');
      }

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
        type: configuration.type,
        tcpHost: configuration.tcpHost,
        tcpPort: configuration.tcpPort,
        icmpHost: configuration.icmpHost,
        dnsName: configuration.dnsName,
        dnsRecordType: configuration.dnsRecordType,
        dnsExpectedValues: configuration.dnsExpectedValues,
        domainName: configuration.domainName,
        domainWarningDays: configuration.domainWarningDays,
        apiWorkflow: configuration.apiWorkflow,
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

  async updateHeartbeatSettings(
    organizationId: string,
    monitorId: string,
    heartbeat: HeartbeatMonitorSettings,
  ): Promise<MonitorRecord> {
    return this.db.transaction(async (tx) => {
      const [monitor] = await tx
        .select()
        .from(monitors)
        .where(and(eq(monitors.id, monitorId), eq(monitors.organizationId, organizationId)))
        .limit(1)
        .for('update');
      if (!monitor) throw new MonitorUpdateNotFoundError();
      if (monitor.type !== 'HEARTBEAT') throw new MonitorProtocolMismatchError('HEARTBEAT');

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

      const intervalSeconds =
        heartbeat.schedule.type === 'INTERVAL' ? heartbeat.schedule.intervalSeconds : 60;
      const [updated] = await tx
        .update(monitors)
        .set({
          heartbeat,
          intervalSeconds,
          nextCheckAt:
            monitor.lifecycleState === 'ENABLED'
              ? nextHeartbeatDeadline(heartbeat.schedule, new Date())
              : null,
          updatedAt: sql`clock_timestamp()`,
        })
        .where(and(eq(monitors.id, monitorId), eq(monitors.organizationId, organizationId)))
        .returning();
      if (!updated) throw new Error('The heartbeat update returned no record.');

      await tx.insert(monitorConfigurationVersions).values({
        organizationId,
        monitorId,
        versionNumber: configuration.versionNumber + 1,
        type: 'HEARTBEAT',
        tcpHost: null,
        tcpPort: null,
        dnsName: null,
        dnsRecordType: null,
        dnsExpectedValues: [],
        apiWorkflow: null,
        heartbeat,
        url: '',
        method: 'GET',
        timeoutMs: configuration.timeoutMs,
        intervalSeconds,
        followRedirects: false,
        statusPolicy: { type: 'ANY_2XX' },
        requestHeaders: [],
        requestBody: { type: 'NONE' },
        assertions: EMPTY_ASSERTION_CONFIGURATION,
        tlsPolicy: { type: 'DISABLED' },
        locations: ['local'],
      });
      return updated;
    });
  }

  async updateLocations(
    organizationId: string,
    monitorId: string,
    requestedLocations: readonly string[],
    workspaceSecretUseAuthorized = true,
  ): Promise<MonitorRecord> {
    return this.db.transaction(async (tx) => {
      const [monitor] = await tx
        .select()
        .from(monitors)
        .where(and(eq(monitors.id, monitorId), eq(monitors.organizationId, organizationId)))
        .limit(1)
        .for('update');
      if (!monitor) throw new MonitorUpdateNotFoundError();
      if (monitor.type === 'DOMAIN_EXPIRY') throw new CentralizedMonitorLocationError();
      assertWorkspaceSecretUseAuthorized(monitor, workspaceSecretUseAuthorized);

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
        type: configuration.type,
        tcpHost: configuration.tcpHost,
        tcpPort: configuration.tcpPort,
        icmpHost: configuration.icmpHost,
        dnsName: configuration.dnsName,
        dnsRecordType: configuration.dnsRecordType,
        dnsExpectedValues: configuration.dnsExpectedValues,
        apiWorkflow: configuration.apiWorkflow,
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
    workspaceSecretUseAuthorized = true,
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
      if (lifecycleState === 'ENABLED') {
        assertWorkspaceSecretUseAuthorized(monitor, workspaceSecretUseAuthorized);
      }
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
              ? monitor.type === 'HEARTBEAT' && monitor.heartbeat
                ? nextHeartbeatDeadline(monitor.heartbeat.schedule, new Date())
                : sql`clock_timestamp() + (${monitor.intervalSeconds} * interval '1 second')`
              : null,
          updatedAt: sql`clock_timestamp()`,
        })
        .where(and(eq(monitors.id, monitorId), eq(monitors.organizationId, organizationId)))
        .returning();
      if (!updated) throw new Error('The monitor update returned no record.');
      if (lifecycleState === 'ARCHIVED') {
        await tx
          .delete(workspaceSecretBindings)
          .where(
            and(
              eq(workspaceSecretBindings.organizationId, organizationId),
              eq(workspaceSecretBindings.resourceType, 'MONITOR'),
              eq(workspaceSecretBindings.resourceId, monitorId),
            ),
          );
      }
      return updated;
    });
  }
}

type MonitorTransaction = Parameters<Parameters<WatchrailDatabase['transaction']>[0]>[0];

interface MonitorSecretBinding {
  secretId: string;
  resourcePath: string;
}

async function reconcileWorkspaceSecretBindings(
  tx: MonitorTransaction,
  organizationId: string,
  monitorId: string,
  requestHeaders: readonly StoredRequestHeader[],
  assertions: ResponseAssertionConfigurationV1,
  apiWorkflow: StoredApiWorkflowConfigurationV1 | null,
): Promise<void> {
  const bindings = collectWorkspaceSecretBindings(requestHeaders, assertions, apiWorkflow);
  const secretIds = [...new Set(bindings.map(({ secretId }) => secretId))].sort();

  // Archive takes the same row lock. Locking in stable order makes reference creation and
  // archival mutually exclusive without introducing a cross-secret deadlock.
  for (const secretId of secretIds) {
    const [secret] = await tx
      .select({ archivedAt: workspaceSecrets.archivedAt })
      .from(workspaceSecrets)
      .where(
        and(eq(workspaceSecrets.organizationId, organizationId), eq(workspaceSecrets.id, secretId)),
      )
      .limit(1)
      .for('update');
    if (!secret || secret.archivedAt) throw new WorkspaceSecretBindingError(secretId);
  }

  await tx
    .delete(workspaceSecretBindings)
    .where(
      and(
        eq(workspaceSecretBindings.organizationId, organizationId),
        eq(workspaceSecretBindings.resourceType, 'MONITOR'),
        eq(workspaceSecretBindings.resourceId, monitorId),
      ),
    );
  if (bindings.length > 0) {
    await tx.insert(workspaceSecretBindings).values(
      bindings.map(({ secretId, resourcePath }) => ({
        organizationId,
        secretId,
        resourceType: 'MONITOR',
        resourceId: monitorId,
        resourcePath,
      })),
    );
  }
}

function collectWorkspaceSecretBindings(
  requestHeaders: readonly StoredRequestHeader[],
  assertions: ResponseAssertionConfigurationV1,
  apiWorkflow: StoredApiWorkflowConfigurationV1 | null,
): MonitorSecretBinding[] {
  const bindings: MonitorSecretBinding[] = [];
  for (const header of requestHeaders) {
    if (header.sensitive && 'secretReference' in header) {
      bindings.push({
        secretId: header.secretReference.secretId,
        resourcePath: `requestHeaders.${header.name}`,
      });
    }
  }
  collectAssertionBindings(bindings, assertions, 'assertions');
  for (const step of apiWorkflow?.steps ?? []) {
    if (step.requestBody.type !== 'NONE' && 'secretReference' in step.requestBody) {
      bindings.push({
        secretId: step.requestBody.secretReference.secretId,
        resourcePath: `workflow.steps.${step.id}.requestBody`,
      });
    }
    for (const header of step.requestHeaders) {
      if (header.sensitive && 'secretReference' in header) {
        bindings.push({
          secretId: header.secretReference.secretId,
          resourcePath: `workflow.steps.${step.id}.requestHeaders.${header.name}`,
        });
      }
    }
    collectAssertionBindings(bindings, step.assertions, `workflow.steps.${step.id}.assertions`);
  }
  return bindings;
}

function collectAssertionBindings(
  bindings: MonitorSecretBinding[],
  configuration: ResponseAssertionConfigurationV1,
  path: string,
): void {
  const groups: ReadonlyArray<
    readonly (StoredHeaderAssertion | StoredTextBodyAssertion | StoredJsonBodyAssertion)[]
  > = [
    configuration.assertions.headers,
    configuration.assertions.textBody,
    configuration.assertions.jsonBody,
  ];
  const fields = ['headers', 'textBody', 'jsonBody'] as const;
  groups.forEach((assertions, groupIndex) => {
    const field = fields[groupIndex]!;
    assertions.forEach((assertion, index) => {
      if ('target' in assertion && 'secretReference' in assertion.target) {
        bindings.push({
          secretId: assertion.target.secretReference.secretId,
          resourcePath: `${path}.${field}.${index}`,
        });
      }
    });
  });
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

export class CentralizedMonitorLocationError extends Error {
  constructor() {
    super('Domain expiry monitors run centrally and cannot use probe locations.');
    this.name = 'CentralizedMonitorLocationError';
  }
}

export class MonitorProtocolMismatchError extends Error {
  constructor(
    protocol: 'HTTP' | 'TCP' | 'DNS' | 'ICMP' | 'API_WORKFLOW' | 'HEARTBEAT' | 'DOMAIN_EXPIRY',
  ) {
    super(`This operation requires a ${protocol} monitor.`);
    this.name = 'MonitorProtocolMismatchError';
  }
}

export class WorkspaceSecretBindingError extends Error {
  constructor(readonly secretId: string) {
    super('Referenced workspace secret is unavailable.');
    this.name = 'WorkspaceSecretBindingError';
  }
}
