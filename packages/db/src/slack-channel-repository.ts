import { randomUUID } from 'node:crypto';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { createSlackTestNotification } from '@watchrail/contracts';
import {
  parseStoredSlackWebhookUrl,
  type EncryptedSlackWebhookUrlV1,
} from '@watchrail/webhook-security';
import type { WatchrailDatabase } from './client.js';
import { archiveNotificationChannel } from './notification-channel-archive.js';
import {
  monitors,
  notificationDeliveries,
  notificationEvents,
  projects,
  webhookEndpointMonitorRoutes,
  webhookEndpoints,
  webhookEndpointVersions,
} from './schema.js';

type Transaction = Parameters<Parameters<WatchrailDatabase['transaction']>[0]>[0];

export interface SlackChannelRoutingInput {
  allMonitors?: boolean;
  monitorIds: string[];
  notifyOnIncident: boolean;
  notifyOnRecovery: boolean;
}

export interface SlackChannelRecord {
  id: string;
  organizationId: string;
  projectId: string;
  name: string;
  enabled: boolean;
  versionNumber: number;
  webhookUrl: { hasValue: true };
  createdAt: Date;
  updatedAt: Date;
  routing: SlackChannelRoutingInput;
}

export interface SlackChannelVersionContext {
  channelId: string;
  versionNumber: number;
  current?: {
    versionNumber: number;
    webhookUrlEnvelope: EncryptedSlackWebhookUrlV1;
  };
}

export class SlackChannelNotFoundError extends Error {
  constructor() {
    super('Slack channel not found.');
    this.name = 'SlackChannelNotFoundError';
  }
}

export class SlackChannelInputError extends Error {
  constructor(readonly fields: Record<string, string[]>) {
    super('Slack channel settings are invalid.');
    this.name = 'SlackChannelInputError';
  }
}

export class SlackChannelTestRateLimitError extends Error {
  constructor(readonly retryAfterSeconds: number) {
    super('Wait before sending another test notification.');
    this.name = 'SlackChannelTestRateLimitError';
  }
}

export class SlackChannelRepository {
  constructor(private readonly db: WatchrailDatabase) {}

  async create(
    organizationId: string,
    input: {
      projectId: string;
      name: string;
      enabled?: boolean;
      routing: SlackChannelRoutingInput;
    },
    createEnvelope: (context: SlackChannelVersionContext) => EncryptedSlackWebhookUrlV1,
  ): Promise<SlackChannelRecord> {
    const name = parseName(input.name);
    const channelId = randomUUID();
    return this.db.transaction(async (tx) => {
      const routing = await validateRouting(tx, organizationId, input.projectId, input.routing);
      const envelope = parseStoredSlackWebhookUrl(createEnvelope({ channelId, versionNumber: 1 }));
      const [channel] = await tx
        .insert(webhookEndpoints)
        .values({
          id: channelId,
          organizationId,
          projectId: input.projectId,
          channelType: 'SLACK',
          name,
          enabled: input.enabled ?? true,
          routeAllMonitors: routing.allMonitors,
          notifyOnIncident: routing.notifyOnIncident,
          notifyOnRecovery: routing.notifyOnRecovery,
        })
        .returning();
      if (!channel) throw new Error('Slack channel creation returned no record.');
      await tx.insert(webhookEndpointVersions).values({
        organizationId,
        endpointId: channelId,
        channelType: 'SLACK',
        versionNumber: 1,
        slackWebhookUrlEnvelope: envelope,
      });
      await replaceRouting(tx, organizationId, channelId, routing);
      return toRecord(channel, 1, routing);
    });
  }

  async updateConfiguration(
    organizationId: string,
    channelId: string,
    input: {
      name: string;
      replaceWebhookUrl: boolean;
      routing: SlackChannelRoutingInput;
    },
    createEnvelope: (context: SlackChannelVersionContext) => EncryptedSlackWebhookUrlV1,
  ): Promise<SlackChannelRecord> {
    const name = parseName(input.name);
    return this.db.transaction(async (tx) => {
      const current = await lockCurrent(tx, organizationId, channelId);
      const routing = await validateRouting(
        tx,
        organizationId,
        requiredProjectId(current.channel.projectId),
        input.routing,
      );
      const nextVersionNumber = input.replaceWebhookUrl
        ? current.channel.currentVersionNumber + 1
        : current.channel.currentVersionNumber;
      if (input.replaceWebhookUrl) {
        const envelope = parseStoredSlackWebhookUrl(
          createEnvelope({
            channelId,
            versionNumber: nextVersionNumber,
            current: {
              versionNumber: current.version.versionNumber,
              webhookUrlEnvelope: slackEnvelope(current.version.slackWebhookUrlEnvelope),
            },
          }),
        );
        await tx.insert(webhookEndpointVersions).values({
          organizationId,
          endpointId: channelId,
          channelType: 'SLACK',
          versionNumber: nextVersionNumber,
          slackWebhookUrlEnvelope: envelope,
        });
      }
      const [channel] = await tx
        .update(webhookEndpoints)
        .set({
          name,
          currentVersionNumber: nextVersionNumber,
          routeAllMonitors: routing.allMonitors,
          notifyOnIncident: routing.notifyOnIncident,
          notifyOnRecovery: routing.notifyOnRecovery,
          updatedAt: sql`clock_timestamp()`,
        })
        .where(
          and(
            eq(webhookEndpoints.organizationId, organizationId),
            eq(webhookEndpoints.id, channelId),
            eq(webhookEndpoints.channelType, 'SLACK'),
          ),
        )
        .returning();
      if (!channel) throw new SlackChannelNotFoundError();
      await replaceRouting(tx, organizationId, channelId, routing);
      return toRecord(channel, nextVersionNumber, routing);
    });
  }

  async setEnabled(
    organizationId: string,
    channelId: string,
    enabled: boolean,
  ): Promise<SlackChannelRecord> {
    if (typeof enabled !== 'boolean')
      throw new SlackChannelInputError({ enabled: ['enabled must be a boolean.'] });
    return this.db.transaction(async (tx) => {
      const current = await lockCurrent(tx, organizationId, channelId);
      const [channel] = await tx
        .update(webhookEndpoints)
        .set({ enabled, updatedAt: sql`clock_timestamp()` })
        .where(
          and(
            eq(webhookEndpoints.organizationId, organizationId),
            eq(webhookEndpoints.id, channelId),
            eq(webhookEndpoints.channelType, 'SLACK'),
          ),
        )
        .returning();
      if (!channel) throw new SlackChannelNotFoundError();
      return toRecord(
        channel,
        current.version.versionNumber,
        await readRouting(tx, organizationId, channelId),
      );
    });
  }

  async listForProject(organizationId: string, projectId: string): Promise<SlackChannelRecord[]> {
    const rows = await currentQuery(this.db, organizationId, undefined, projectId);
    return Promise.all(
      rows.map(async ({ channel, version }) =>
        toRecord(
          channel,
          version.versionNumber,
          await readRouting(this.db, organizationId, channel.id),
        ),
      ),
    );
  }

  async findForOrganization(
    organizationId: string,
    channelId: string,
  ): Promise<SlackChannelRecord | null> {
    const [row] = await currentQuery(this.db, organizationId, channelId);
    return row
      ? toRecord(
          row.channel,
          row.version.versionNumber,
          await readRouting(this.db, organizationId, channelId),
        )
      : null;
  }

  async stageTest(organizationId: string, channelId: string): Promise<{ deliveryId: string }> {
    return this.db.transaction(async (tx) => {
      const current = await lockCurrent(tx, organizationId, channelId);
      const recent = await tx.execute<{ seconds: number }>(sql`
        select extract(epoch from (clock_timestamp() - event.occurred_at))::integer as seconds
        from notification_deliveries delivery
        join notification_events event on event.organization_id=delivery.organization_id
          and event.id=delivery.event_id
        where delivery.organization_id=${organizationId}::uuid
          and delivery.endpoint_id=${channelId}::uuid and event.event_type='TEST'
          and event.occurred_at > clock_timestamp() - interval '30 seconds'
        order by event.occurred_at desc limit 1
      `);
      const elapsed = recent.rows[0]?.seconds;
      if (elapsed !== undefined)
        throw new SlackChannelTestRateLimitError(Math.max(1, 30 - elapsed));
      const eventId = randomUUID();
      const deliveryId = randomUUID();
      const occurredAt = new Date();
      await tx.insert(notificationEvents).values({
        id: eventId,
        organizationId,
        eventType: 'TEST',
        occurredAt,
        payload: createSlackTestNotification({
          eventId,
          occurredAt,
          organizationId,
          channel: { id: channelId, name: current.channel.name },
        }),
      });
      await tx.insert(notificationDeliveries).values({
        id: deliveryId,
        organizationId,
        eventId,
        endpointId: channelId,
        endpointVersionId: current.version.id,
      });
      return { deliveryId };
    });
  }

  async archive(organizationId: string, channelId: string): Promise<void> {
    if (!(await archiveNotificationChannel(this.db, organizationId, channelId, 'SLACK')))
      throw new SlackChannelNotFoundError();
  }
}

async function lockCurrent(tx: Transaction, organizationId: string, channelId: string) {
  const [channel] = await tx
    .select()
    .from(webhookEndpoints)
    .where(
      and(
        eq(webhookEndpoints.organizationId, organizationId),
        eq(webhookEndpoints.id, channelId),
        eq(webhookEndpoints.channelType, 'SLACK'),
        isNull(webhookEndpoints.archivedAt),
      ),
    )
    .limit(1)
    .for('update');
  if (!channel) throw new SlackChannelNotFoundError();
  const [version] = await tx
    .select()
    .from(webhookEndpointVersions)
    .where(
      and(
        eq(webhookEndpointVersions.organizationId, organizationId),
        eq(webhookEndpointVersions.endpointId, channelId),
        eq(webhookEndpointVersions.channelType, 'SLACK'),
        eq(webhookEndpointVersions.versionNumber, channel.currentVersionNumber),
      ),
    )
    .limit(1);
  if (!version) throw new Error('Slack channel current version is missing.');
  slackEnvelope(version.slackWebhookUrlEnvelope);
  return { channel, version };
}

function currentQuery(
  db: WatchrailDatabase,
  organizationId: string,
  channelId?: string,
  projectId?: string,
) {
  return db
    .select({ channel: webhookEndpoints, version: webhookEndpointVersions })
    .from(webhookEndpoints)
    .innerJoin(
      webhookEndpointVersions,
      and(
        eq(webhookEndpointVersions.organizationId, webhookEndpoints.organizationId),
        eq(webhookEndpointVersions.endpointId, webhookEndpoints.id),
        eq(webhookEndpointVersions.channelType, 'SLACK'),
        eq(webhookEndpointVersions.versionNumber, webhookEndpoints.currentVersionNumber),
      ),
    )
    .where(
      and(
        eq(webhookEndpoints.organizationId, organizationId),
        eq(webhookEndpoints.channelType, 'SLACK'),
        isNull(webhookEndpoints.archivedAt),
        channelId ? eq(webhookEndpoints.id, channelId) : undefined,
        projectId ? eq(webhookEndpoints.projectId, projectId) : undefined,
      ),
    )
    .orderBy(webhookEndpoints.createdAt, webhookEndpoints.id);
}

async function validateRouting(
  tx: Transaction,
  organizationId: string,
  projectId: string,
  input: SlackChannelRoutingInput,
): Promise<SlackChannelRoutingInput> {
  const [project] = await tx
    .select({ id: projects.id })
    .from(projects)
    .where(and(eq(projects.organizationId, organizationId), eq(projects.id, projectId)))
    .limit(1);
  if (!project) throw new SlackChannelInputError({ projectId: ['Project not found.'] });
  if (!input.notifyOnIncident && !input.notifyOnRecovery)
    throw new SlackChannelInputError({ routing: ['Choose at least one incident event.'] });
  const allMonitors = input.allMonitors ?? false;
  const monitorIds = allMonitors
    ? []
    : [...new Set(input.monitorIds.map((id) => id.toLowerCase()))];
  if (monitorIds.length !== input.monitorIds.length)
    throw new SlackChannelInputError({ monitorIds: ['Monitor IDs must be unique.'] });
  if (monitorIds.length > 500)
    throw new SlackChannelInputError({ monitorIds: ['At most 500 monitors can be routed.'] });
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
      throw new SlackChannelInputError({
        monitorIds: ['Every monitor must belong to the selected project.'],
      });
  }
  return { ...input, allMonitors, monitorIds };
}

async function replaceRouting(
  tx: Transaction,
  organizationId: string,
  channelId: string,
  routing: SlackChannelRoutingInput,
) {
  await tx
    .delete(webhookEndpointMonitorRoutes)
    .where(
      and(
        eq(webhookEndpointMonitorRoutes.organizationId, organizationId),
        eq(webhookEndpointMonitorRoutes.endpointId, channelId),
      ),
    );
  if (routing.monitorIds.length)
    await tx.insert(webhookEndpointMonitorRoutes).values(
      routing.monitorIds.map((monitorId) => ({
        organizationId,
        endpointId: channelId,
        monitorId,
      })),
    );
}

async function readRouting(
  db: Pick<WatchrailDatabase, 'select'>,
  organizationId: string,
  channelId: string,
): Promise<SlackChannelRoutingInput> {
  const [channel] = await db
    .select({
      allMonitors: webhookEndpoints.routeAllMonitors,
      notifyOnIncident: webhookEndpoints.notifyOnIncident,
      notifyOnRecovery: webhookEndpoints.notifyOnRecovery,
    })
    .from(webhookEndpoints)
    .where(
      and(
        eq(webhookEndpoints.organizationId, organizationId),
        eq(webhookEndpoints.id, channelId),
        eq(webhookEndpoints.channelType, 'SLACK'),
      ),
    )
    .limit(1);
  if (!channel) throw new SlackChannelNotFoundError();
  const routes = await db
    .select({ monitorId: webhookEndpointMonitorRoutes.monitorId })
    .from(webhookEndpointMonitorRoutes)
    .where(
      and(
        eq(webhookEndpointMonitorRoutes.organizationId, organizationId),
        eq(webhookEndpointMonitorRoutes.endpointId, channelId),
      ),
    )
    .orderBy(webhookEndpointMonitorRoutes.monitorId);
  return { ...channel, monitorIds: routes.map(({ monitorId }) => monitorId) };
}

function parseName(value: string): string {
  const name = value.trim();
  if (!name || name.length > 120 || hasControlCharacter(name))
    throw new SlackChannelInputError({ name: ['Name must contain 1 to 120 characters.'] });
  return name;
}

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && (codePoint < 32 || codePoint === 127);
  });
}

function slackEnvelope(value: unknown): EncryptedSlackWebhookUrlV1 {
  if (!value) throw new Error('Slack channel version is missing its webhook credential.');
  return parseStoredSlackWebhookUrl(value);
}

function requiredProjectId(value: string | null): string {
  if (!value) throw new Error('Slack channel is missing its project.');
  return value;
}

function toRecord(
  channel: typeof webhookEndpoints.$inferSelect,
  versionNumber: number,
  routing: SlackChannelRoutingInput,
): SlackChannelRecord {
  return {
    id: channel.id,
    organizationId: channel.organizationId,
    projectId: requiredProjectId(channel.projectId),
    name: channel.name,
    enabled: channel.enabled,
    versionNumber,
    webhookUrl: { hasValue: true },
    createdAt: channel.createdAt,
    updatedAt: channel.updatedAt,
    routing,
  };
}
