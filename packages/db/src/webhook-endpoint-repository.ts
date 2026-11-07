import { randomUUID } from 'node:crypto';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import {
  parseStoredWebhookSigningSecret,
  type EncryptedWebhookSigningSecretV1,
} from '@watchrail/webhook-security';
import type { WatchrailDatabase } from './client.js';
import { archiveNotificationChannel } from './notification-channel-archive.js';
import {
  monitors,
  projects,
  webhookEndpointMonitorRoutes,
  webhookEndpoints,
  webhookEndpointVersions,
} from './schema.js';

type Transaction = Parameters<Parameters<WatchrailDatabase['transaction']>[0]>[0];

export interface WebhookEndpointRecord {
  id: string;
  organizationId: string;
  projectId: string | null;
  name: string;
  enabled: boolean;
  versionNumber: number;
  url: string;
  createdAt: Date;
  updatedAt: Date;
  routing: {
    allMonitors?: boolean;
    monitorIds: string[];
    notifyOnIncident: boolean;
    notifyOnRecovery: boolean;
  };
}

export interface WebhookEndpointRoutingInput {
  allMonitors?: boolean;
  monitorIds: string[];
  notifyOnIncident: boolean;
  notifyOnRecovery: boolean;
}

export interface WebhookEndpointVersionContext {
  endpointId: string;
  versionNumber: number;
  current?: {
    versionNumber: number;
    url: string;
    signingSecretEnvelope: EncryptedWebhookSigningSecretV1;
  };
}

export class WebhookEndpointNotFoundError extends Error {
  constructor() {
    super('Webhook endpoint not found.');
    this.name = 'WebhookEndpointNotFoundError';
  }
}

export class WebhookEndpointInputError extends Error {
  constructor(readonly fields: Record<string, string[]>) {
    super('Webhook endpoint settings are invalid.');
    this.name = 'WebhookEndpointInputError';
  }
}

export class WebhookEndpointRepository {
  constructor(private readonly db: WatchrailDatabase) {}

  async create(
    organizationId: string,
    input: {
      name: string;
      url: string;
      enabled?: boolean;
      projectId?: string;
      routing?: WebhookEndpointRoutingInput;
    },
    createEnvelope: (context: WebhookEndpointVersionContext) => EncryptedWebhookSigningSecretV1,
  ): Promise<WebhookEndpointRecord> {
    const settings = parseSettings(input.name, input.url);
    const endpointId = randomUUID();
    return this.db.transaction(async (tx) => {
      const routing = await this.validateRouting(
        tx,
        organizationId,
        input.projectId,
        input.routing,
      );
      const envelope = parseStoredWebhookSigningSecret(
        createEnvelope({ endpointId, versionNumber: 1 }),
      );
      const [endpoint] = await tx
        .insert(webhookEndpoints)
        .values({
          id: endpointId,
          organizationId,
          projectId: input.projectId ?? null,
          name: settings.name,
          enabled: input.enabled ?? true,
          routeAllMonitors: routing.allMonitors,
          notifyOnIncident: routing.notifyOnIncident,
          notifyOnRecovery: routing.notifyOnRecovery,
        })
        .returning();
      if (!endpoint) throw new Error('Webhook endpoint creation returned no record.');
      await tx.insert(webhookEndpointVersions).values({
        organizationId,
        endpointId,
        versionNumber: 1,
        url: settings.url,
        signingSecretEnvelope: envelope,
      });
      await this.replaceRouting(tx, organizationId, endpointId, routing);
      return toRecord(endpoint, 1, settings.url, routing);
    });
  }

  async updateSettings(
    organizationId: string,
    endpointId: string,
    input: { name: string; url: string; rotateSecret: boolean },
    createEnvelope: (context: WebhookEndpointVersionContext) => EncryptedWebhookSigningSecretV1,
  ): Promise<WebhookEndpointRecord> {
    const settings = parseSettings(input.name, input.url);
    return this.db.transaction(async (tx) => {
      const current = await this.lockCurrent(tx, organizationId, endpointId);
      const configurationChanged = settings.url !== current.version.url || input.rotateSecret;
      const nextVersionNumber = configurationChanged
        ? current.endpoint.currentVersionNumber + 1
        : current.endpoint.currentVersionNumber;
      if (configurationChanged) {
        const envelope = parseStoredWebhookSigningSecret(
          createEnvelope({
            endpointId,
            versionNumber: nextVersionNumber,
            current: {
              versionNumber: current.version.versionNumber,
              url: webhookUrl(current.version.url),
              signingSecretEnvelope: parseStoredWebhookSigningSecret(
                webhookSecret(current.version.signingSecretEnvelope),
              ),
            },
          }),
        );
        await tx.insert(webhookEndpointVersions).values({
          organizationId,
          endpointId,
          versionNumber: nextVersionNumber,
          url: settings.url,
          signingSecretEnvelope: envelope,
        });
      }
      const endpointChanged =
        settings.name !== current.endpoint.name ||
        nextVersionNumber !== current.endpoint.currentVersionNumber;
      const endpoint = endpointChanged
        ? (
            await tx
              .update(webhookEndpoints)
              .set({
                name: settings.name,
                currentVersionNumber: nextVersionNumber,
                updatedAt: sql`clock_timestamp()`,
              })
              .where(
                and(
                  eq(webhookEndpoints.organizationId, organizationId),
                  eq(webhookEndpoints.id, endpointId),
                ),
              )
              .returning()
          )[0]
        : current.endpoint;
      if (!endpoint) throw new Error('Webhook endpoint update returned no record.');
      const routing = await this.readRouting(tx, organizationId, endpointId);
      return toRecord(endpoint, nextVersionNumber, settings.url, routing);
    });
  }

  async updateConfiguration(
    organizationId: string,
    endpointId: string,
    input: {
      name: string;
      url: string;
      rotateSecret: boolean;
      routing: WebhookEndpointRoutingInput;
    },
    createEnvelope: (context: WebhookEndpointVersionContext) => EncryptedWebhookSigningSecretV1,
  ): Promise<WebhookEndpointRecord> {
    const settings = parseSettings(input.name, input.url);
    return this.db.transaction(async (tx) => {
      const current = await this.lockCurrent(tx, organizationId, endpointId);
      if (!current.endpoint.projectId)
        throw new WebhookEndpointInputError({
          projectId: ['Legacy workspace-wide endpoints cannot use project routing.'],
        });
      const routing = await this.validateRouting(
        tx,
        organizationId,
        current.endpoint.projectId,
        input.routing,
      );
      const currentRouting = await this.readRouting(tx, organizationId, endpointId);
      const routingChanged = !sameRouting(currentRouting, routing);
      const configurationChanged = settings.url !== current.version.url || input.rotateSecret;
      const nextVersionNumber = configurationChanged
        ? current.endpoint.currentVersionNumber + 1
        : current.endpoint.currentVersionNumber;
      if (configurationChanged) {
        const envelope = parseStoredWebhookSigningSecret(
          createEnvelope({
            endpointId,
            versionNumber: nextVersionNumber,
            current: {
              versionNumber: current.version.versionNumber,
              url: webhookUrl(current.version.url),
              signingSecretEnvelope: parseStoredWebhookSigningSecret(
                webhookSecret(current.version.signingSecretEnvelope),
              ),
            },
          }),
        );
        await tx.insert(webhookEndpointVersions).values({
          organizationId,
          endpointId,
          versionNumber: nextVersionNumber,
          url: settings.url,
          signingSecretEnvelope: envelope,
        });
      }
      const endpointChanged =
        settings.name !== current.endpoint.name ||
        nextVersionNumber !== current.endpoint.currentVersionNumber ||
        routingChanged;
      const endpoint = endpointChanged
        ? (
            await tx
              .update(webhookEndpoints)
              .set({
                name: settings.name,
                currentVersionNumber: nextVersionNumber,
                routeAllMonitors: routing.allMonitors,
                notifyOnIncident: routing.notifyOnIncident,
                notifyOnRecovery: routing.notifyOnRecovery,
                updatedAt: sql`clock_timestamp()`,
              })
              .where(
                and(
                  eq(webhookEndpoints.organizationId, organizationId),
                  eq(webhookEndpoints.id, endpointId),
                ),
              )
              .returning()
          )[0]
        : current.endpoint;
      if (!endpoint) throw new Error('Webhook endpoint update returned no record.');
      await this.replaceRouting(tx, organizationId, endpointId, routing);
      return toRecord(endpoint, nextVersionNumber, settings.url, routing);
    });
  }

  async setEnabled(
    organizationId: string,
    endpointId: string,
    enabled: boolean,
  ): Promise<WebhookEndpointRecord> {
    if (typeof enabled !== 'boolean')
      throw new WebhookEndpointInputError({ enabled: ['enabled must be a boolean.'] });
    return this.db.transaction(async (tx) => {
      const current = await this.lockCurrent(tx, organizationId, endpointId);
      if (current.endpoint.enabled === enabled)
        return toRecord(
          current.endpoint,
          current.version.versionNumber,
          webhookUrl(current.version.url),
          await this.readRouting(tx, organizationId, endpointId),
        );
      const [endpoint] = await tx
        .update(webhookEndpoints)
        .set({ enabled, updatedAt: sql`clock_timestamp()` })
        .where(
          and(
            eq(webhookEndpoints.organizationId, organizationId),
            eq(webhookEndpoints.id, endpointId),
          ),
        )
        .returning();
      if (!endpoint) throw new WebhookEndpointNotFoundError();
      return toRecord(
        endpoint,
        current.version.versionNumber,
        webhookUrl(current.version.url),
        await this.readRouting(tx, organizationId, endpointId),
      );
    });
  }

  async updateRouting(
    organizationId: string,
    endpointId: string,
    input: WebhookEndpointRoutingInput,
  ): Promise<WebhookEndpointRecord> {
    return this.db.transaction(async (tx) => {
      const current = await this.lockCurrent(tx, organizationId, endpointId);
      if (!current.endpoint.projectId)
        throw new WebhookEndpointInputError({
          projectId: ['Legacy workspace-wide endpoints cannot use project routing.'],
        });
      const routing = await this.validateRouting(
        tx,
        organizationId,
        current.endpoint.projectId,
        input,
      );
      const currentRouting = await this.readRouting(tx, organizationId, endpointId);
      if (sameRouting(currentRouting, routing))
        return toRecord(
          current.endpoint,
          current.version.versionNumber,
          webhookUrl(current.version.url),
          routing,
        );
      const [endpoint] = await tx
        .update(webhookEndpoints)
        .set({
          routeAllMonitors: routing.allMonitors,
          notifyOnIncident: routing.notifyOnIncident,
          notifyOnRecovery: routing.notifyOnRecovery,
          updatedAt: sql`clock_timestamp()`,
        })
        .where(
          and(
            eq(webhookEndpoints.organizationId, organizationId),
            eq(webhookEndpoints.id, endpointId),
          ),
        )
        .returning();
      if (!endpoint) throw new WebhookEndpointNotFoundError();
      await this.replaceRouting(tx, organizationId, endpointId, routing);
      return toRecord(
        endpoint,
        current.version.versionNumber,
        webhookUrl(current.version.url),
        routing,
      );
    });
  }

  async listForOrganization(
    organizationId: string,
    projectId?: string,
  ): Promise<WebhookEndpointRecord[]> {
    const rows = await this.currentQuery(this.db, organizationId, undefined, projectId);
    return Promise.all(
      rows.map(async (row) =>
        toRecord(
          row.endpoint,
          row.version.versionNumber,
          webhookUrl(row.version.url),
          await this.readRouting(this.db, organizationId, row.endpoint.id),
        ),
      ),
    );
  }

  async findForOrganization(
    organizationId: string,
    endpointId: string,
  ): Promise<WebhookEndpointRecord | null> {
    const rows = await this.currentQuery(this.db, organizationId, endpointId);
    const row = rows[0];
    return row
      ? toRecord(
          row.endpoint,
          row.version.versionNumber,
          webhookUrl(row.version.url),
          await this.readRouting(this.db, organizationId, row.endpoint.id),
        )
      : null;
  }

  async archive(organizationId: string, endpointId: string): Promise<void> {
    if (!(await archiveNotificationChannel(this.db, organizationId, endpointId, 'WEBHOOK')))
      throw new WebhookEndpointNotFoundError();
  }

  private currentQuery(
    db: WatchrailDatabase,
    organizationId: string,
    endpointId?: string,
    projectId?: string,
  ) {
    return db
      .select({ endpoint: webhookEndpoints, version: webhookEndpointVersions })
      .from(webhookEndpoints)
      .innerJoin(
        webhookEndpointVersions,
        and(
          eq(webhookEndpointVersions.organizationId, webhookEndpoints.organizationId),
          eq(webhookEndpointVersions.endpointId, webhookEndpoints.id),
          eq(webhookEndpointVersions.versionNumber, webhookEndpoints.currentVersionNumber),
        ),
      )
      .where(
        and(
          eq(webhookEndpoints.organizationId, organizationId),
          eq(webhookEndpoints.channelType, 'WEBHOOK'),
          isNull(webhookEndpoints.archivedAt),
          endpointId === undefined ? undefined : eq(webhookEndpoints.id, endpointId),
          projectId === undefined ? undefined : eq(webhookEndpoints.projectId, projectId),
        ),
      )
      .orderBy(webhookEndpoints.createdAt, webhookEndpoints.id);
  }

  private async lockCurrent(tx: Transaction, organizationId: string, endpointId: string) {
    const [endpoint] = await tx
      .select()
      .from(webhookEndpoints)
      .where(
        and(
          eq(webhookEndpoints.organizationId, organizationId),
          eq(webhookEndpoints.id, endpointId),
          eq(webhookEndpoints.channelType, 'WEBHOOK'),
          isNull(webhookEndpoints.archivedAt),
        ),
      )
      .limit(1)
      .for('update');
    if (!endpoint) throw new WebhookEndpointNotFoundError();
    const [version] = await tx
      .select()
      .from(webhookEndpointVersions)
      .where(
        and(
          eq(webhookEndpointVersions.organizationId, organizationId),
          eq(webhookEndpointVersions.endpointId, endpointId),
          eq(webhookEndpointVersions.versionNumber, endpoint.currentVersionNumber),
        ),
      )
      .limit(1);
    if (!version) throw new Error('Webhook endpoint current version is missing.');
    return { endpoint, version };
  }

  private async validateRouting(
    tx: Transaction,
    organizationId: string,
    projectId: string | undefined,
    input: WebhookEndpointRoutingInput | undefined,
  ): Promise<WebhookEndpointRoutingInput> {
    if (!projectId) {
      if (input && input.monitorIds.length > 0)
        throw new WebhookEndpointInputError({
          projectId: ['projectId is required when monitor routing is configured.'],
        });
      return (
        input ?? {
          allMonitors: true,
          monitorIds: [],
          notifyOnIncident: true,
          notifyOnRecovery: true,
        }
      );
    }
    const [project] = await tx
      .select({ id: projects.id })
      .from(projects)
      .where(and(eq(projects.organizationId, organizationId), eq(projects.id, projectId)))
      .limit(1);
    if (!project) throw new WebhookEndpointInputError({ projectId: ['Project not found.'] });
    if (!input)
      throw new WebhookEndpointInputError({ routing: ['Routing settings are required.'] });
    if (typeof input.notifyOnIncident !== 'boolean' || typeof input.notifyOnRecovery !== 'boolean')
      throw new WebhookEndpointInputError({ routing: ['Routing event settings are invalid.'] });
    if (!input.notifyOnIncident && !input.notifyOnRecovery)
      throw new WebhookEndpointInputError({
        routing: ['Choose at least one incident event to deliver.'],
      });
    const allMonitors = input.allMonitors ?? false;
    const monitorIds = allMonitors
      ? []
      : [...new Set(input.monitorIds.map((id) => id.toLowerCase()))];
    if (monitorIds.length !== input.monitorIds.length)
      throw new WebhookEndpointInputError({ monitorIds: ['Monitor IDs must be unique.'] });
    if (monitorIds.length > 500)
      throw new WebhookEndpointInputError({ monitorIds: ['At most 500 monitors can be routed.'] });
    if (monitorIds.length > 0) {
      const selected = await tx
        .select({ id: monitors.id })
        .from(monitors)
        .where(
          and(
            eq(monitors.organizationId, organizationId),
            eq(monitors.projectId, projectId),
            inArray(monitors.id, monitorIds),
          ),
        );
      if (selected.length !== monitorIds.length)
        throw new WebhookEndpointInputError({
          monitorIds: ['Every monitor must belong to the selected project.'],
        });
    }
    return {
      allMonitors,
      monitorIds,
      notifyOnIncident: input.notifyOnIncident,
      notifyOnRecovery: input.notifyOnRecovery,
    };
  }

  private async replaceRouting(
    tx: Transaction,
    organizationId: string,
    endpointId: string,
    routing: WebhookEndpointRoutingInput,
  ): Promise<void> {
    await tx
      .delete(webhookEndpointMonitorRoutes)
      .where(
        and(
          eq(webhookEndpointMonitorRoutes.organizationId, organizationId),
          eq(webhookEndpointMonitorRoutes.endpointId, endpointId),
        ),
      );
    if (routing.monitorIds.length > 0)
      await tx.insert(webhookEndpointMonitorRoutes).values(
        routing.monitorIds.map((monitorId) => ({
          organizationId,
          endpointId,
          monitorId,
        })),
      );
  }

  private async readRouting(
    db: Pick<WatchrailDatabase, 'select'>,
    organizationId: string,
    endpointId: string,
  ): Promise<WebhookEndpointRoutingInput> {
    const [endpoint] = await db
      .select({
        allMonitors: webhookEndpoints.routeAllMonitors,
        notifyOnIncident: webhookEndpoints.notifyOnIncident,
        notifyOnRecovery: webhookEndpoints.notifyOnRecovery,
      })
      .from(webhookEndpoints)
      .where(
        and(
          eq(webhookEndpoints.organizationId, organizationId),
          eq(webhookEndpoints.id, endpointId),
        ),
      )
      .limit(1);
    if (!endpoint) throw new WebhookEndpointNotFoundError();
    const routes = await db
      .select({
        monitorId: webhookEndpointMonitorRoutes.monitorId,
      })
      .from(webhookEndpointMonitorRoutes)
      .where(
        and(
          eq(webhookEndpointMonitorRoutes.organizationId, organizationId),
          eq(webhookEndpointMonitorRoutes.endpointId, endpointId),
        ),
      )
      .orderBy(webhookEndpointMonitorRoutes.monitorId);
    return {
      allMonitors: endpoint.allMonitors,
      monitorIds: routes.map((route) => route.monitorId),
      notifyOnIncident: endpoint.notifyOnIncident,
      notifyOnRecovery: endpoint.notifyOnRecovery,
    };
  }
}

function sameRouting(
  left: WebhookEndpointRoutingInput,
  right: WebhookEndpointRoutingInput,
): boolean {
  const rightMonitorIds = new Set(right.monitorIds);
  return (
    (left.allMonitors ?? false) === (right.allMonitors ?? false) &&
    left.notifyOnIncident === right.notifyOnIncident &&
    left.notifyOnRecovery === right.notifyOnRecovery &&
    left.monitorIds.length === right.monitorIds.length &&
    left.monitorIds.every((monitorId) => rightMonitorIds.has(monitorId))
  );
}

function webhookUrl(value: string | null): string {
  if (!value) throw new Error('Webhook endpoint version is missing its URL.');
  return value;
}

function webhookSecret(value: unknown): unknown {
  if (!value) throw new Error('Webhook endpoint version is missing its signing secret.');
  return value;
}

function parseSettings(nameValue: string, urlValue: string): { name: string; url: string } {
  const fields: Record<string, string[]> = {};
  const name = typeof nameValue === 'string' ? nameValue.trim() : '';
  if (!name || name.length > 120)
    fields.name = ['name must contain 1 to 120 non-whitespace characters.'];
  let url = '';
  try {
    const parsed = new URL(urlValue);
    if (
      !['http:', 'https:'].includes(parsed.protocol) ||
      parsed.username ||
      parsed.password ||
      !parsed.hostname ||
      urlValue.length > 2048 ||
      parsed.toString().length > 2048
    )
      throw new Error();
    url = parsed.toString();
  } catch {
    fields.url = ['url must be an absolute HTTP(S) URL without credentials.'];
  }
  if (Object.keys(fields).length > 0) throw new WebhookEndpointInputError(fields);
  return { name, url };
}

function toRecord(
  endpoint: typeof webhookEndpoints.$inferSelect,
  versionNumber: number,
  url: string,
  routing: WebhookEndpointRoutingInput,
): WebhookEndpointRecord {
  return {
    id: endpoint.id,
    organizationId: endpoint.organizationId,
    projectId: endpoint.projectId,
    name: endpoint.name,
    enabled: endpoint.enabled,
    versionNumber,
    url,
    createdAt: endpoint.createdAt,
    updatedAt: endpoint.updatedAt,
    routing,
  };
}
