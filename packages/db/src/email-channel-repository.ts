import { randomUUID } from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { createEmailTestNotification } from '@watchrail/contracts';
import type { WatchrailDatabase } from './client.js';
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

export interface EmailChannelRoutingInput {
  monitorIds: string[];
  notifyOnIncident: boolean;
  notifyOnRecovery: boolean;
}

export interface EmailChannelRecord {
  id: string;
  organizationId: string;
  projectId: string;
  name: string;
  enabled: boolean;
  versionNumber: number;
  recipientEmails: string[];
  createdAt: Date;
  updatedAt: Date;
  routing: EmailChannelRoutingInput;
}

export class EmailChannelNotFoundError extends Error {
  constructor() {
    super('Email channel not found.');
    this.name = 'EmailChannelNotFoundError';
  }
}

export class EmailChannelInputError extends Error {
  constructor(readonly fields: Record<string, string[]>) {
    super('Email channel settings are invalid.');
    this.name = 'EmailChannelInputError';
  }
}

export class EmailChannelTestRateLimitError extends Error {
  constructor(readonly retryAfterSeconds: number) {
    super('Wait before sending another test notification.');
    this.name = 'EmailChannelTestRateLimitError';
  }
}

export class EmailChannelRepository {
  constructor(private readonly db: WatchrailDatabase) {}

  async create(
    organizationId: string,
    input: {
      projectId: string;
      name: string;
      recipientEmails: string[];
      enabled?: boolean;
      routing: EmailChannelRoutingInput;
    },
  ): Promise<EmailChannelRecord> {
    const name = parseName(input.name);
    const recipientEmails = parseRecipients(input.recipientEmails);
    const channelId = randomUUID();
    return this.db.transaction(async (tx) => {
      const routing = await validateRouting(tx, organizationId, input.projectId, input.routing);
      const [channel] = await tx
        .insert(webhookEndpoints)
        .values({
          id: channelId,
          organizationId,
          projectId: input.projectId,
          channelType: 'EMAIL',
          name,
          enabled: input.enabled ?? true,
          notifyOnIncident: routing.notifyOnIncident,
          notifyOnRecovery: routing.notifyOnRecovery,
        })
        .returning();
      if (!channel) throw new Error('Email channel creation returned no record.');
      await tx.insert(webhookEndpointVersions).values({
        organizationId,
        endpointId: channelId,
        channelType: 'EMAIL',
        versionNumber: 1,
        recipientEmails,
      });
      await replaceRouting(tx, organizationId, channelId, routing);
      return toRecord(channel, 1, recipientEmails, routing);
    });
  }

  async updateConfiguration(
    organizationId: string,
    channelId: string,
    input: {
      name: string;
      recipientEmails: string[];
      routing: EmailChannelRoutingInput;
    },
  ): Promise<EmailChannelRecord> {
    const name = parseName(input.name);
    const recipientEmails = parseRecipients(input.recipientEmails);
    return this.db.transaction(async (tx) => {
      const current = await lockCurrent(tx, organizationId, channelId);
      const routing = await validateRouting(
        tx,
        organizationId,
        requiredProjectId(current.channel.projectId),
        input.routing,
      );
      const currentRecipients = emailRecipients(current.version.recipientEmails);
      const versionChanged = !sameStrings(currentRecipients, recipientEmails);
      const nextVersionNumber = versionChanged
        ? current.channel.currentVersionNumber + 1
        : current.channel.currentVersionNumber;
      if (versionChanged)
        await tx.insert(webhookEndpointVersions).values({
          organizationId,
          endpointId: channelId,
          channelType: 'EMAIL',
          versionNumber: nextVersionNumber,
          recipientEmails,
        });
      const [channel] = await tx
        .update(webhookEndpoints)
        .set({
          name,
          currentVersionNumber: nextVersionNumber,
          notifyOnIncident: routing.notifyOnIncident,
          notifyOnRecovery: routing.notifyOnRecovery,
          updatedAt: sql`clock_timestamp()`,
        })
        .where(
          and(
            eq(webhookEndpoints.organizationId, organizationId),
            eq(webhookEndpoints.id, channelId),
            eq(webhookEndpoints.channelType, 'EMAIL'),
          ),
        )
        .returning();
      if (!channel) throw new EmailChannelNotFoundError();
      await replaceRouting(tx, organizationId, channelId, routing);
      return toRecord(channel, nextVersionNumber, recipientEmails, routing);
    });
  }

  async setEnabled(
    organizationId: string,
    channelId: string,
    enabled: boolean,
  ): Promise<EmailChannelRecord> {
    if (typeof enabled !== 'boolean')
      throw new EmailChannelInputError({ enabled: ['enabled must be a boolean.'] });
    return this.db.transaction(async (tx) => {
      const current = await lockCurrent(tx, organizationId, channelId);
      const [channel] = await tx
        .update(webhookEndpoints)
        .set({ enabled, updatedAt: sql`clock_timestamp()` })
        .where(
          and(
            eq(webhookEndpoints.organizationId, organizationId),
            eq(webhookEndpoints.id, channelId),
            eq(webhookEndpoints.channelType, 'EMAIL'),
          ),
        )
        .returning();
      if (!channel) throw new EmailChannelNotFoundError();
      return toRecord(
        channel,
        current.version.versionNumber,
        emailRecipients(current.version.recipientEmails),
        await readRouting(tx, organizationId, channelId),
      );
    });
  }

  async listForProject(organizationId: string, projectId: string): Promise<EmailChannelRecord[]> {
    const rows = await currentQuery(this.db, organizationId, undefined, projectId);
    return Promise.all(
      rows.map(async ({ channel, version }) =>
        toRecord(
          channel,
          version.versionNumber,
          emailRecipients(version.recipientEmails),
          await readRouting(this.db, organizationId, channel.id),
        ),
      ),
    );
  }

  async findForOrganization(
    organizationId: string,
    channelId: string,
  ): Promise<EmailChannelRecord | null> {
    const [row] = await currentQuery(this.db, organizationId, channelId);
    return row
      ? toRecord(
          row.channel,
          row.version.versionNumber,
          emailRecipients(row.version.recipientEmails),
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
        throw new EmailChannelTestRateLimitError(Math.max(1, 30 - elapsed));
      const eventId = randomUUID();
      const deliveryId = randomUUID();
      const occurredAt = new Date();
      await tx.insert(notificationEvents).values({
        id: eventId,
        organizationId,
        eventType: 'TEST',
        occurredAt,
        payload: createEmailTestNotification({
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
}

async function lockCurrent(tx: Transaction, organizationId: string, channelId: string) {
  const [channel] = await tx
    .select()
    .from(webhookEndpoints)
    .where(
      and(
        eq(webhookEndpoints.organizationId, organizationId),
        eq(webhookEndpoints.id, channelId),
        eq(webhookEndpoints.channelType, 'EMAIL'),
      ),
    )
    .limit(1)
    .for('update');
  if (!channel) throw new EmailChannelNotFoundError();
  const [version] = await tx
    .select()
    .from(webhookEndpointVersions)
    .where(
      and(
        eq(webhookEndpointVersions.organizationId, organizationId),
        eq(webhookEndpointVersions.endpointId, channelId),
        eq(webhookEndpointVersions.channelType, 'EMAIL'),
        eq(webhookEndpointVersions.versionNumber, channel.currentVersionNumber),
      ),
    )
    .limit(1);
  if (!version) throw new Error('Email channel current version is missing.');
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
        eq(webhookEndpointVersions.channelType, 'EMAIL'),
        eq(webhookEndpointVersions.versionNumber, webhookEndpoints.currentVersionNumber),
      ),
    )
    .where(
      and(
        eq(webhookEndpoints.organizationId, organizationId),
        eq(webhookEndpoints.channelType, 'EMAIL'),
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
  input: EmailChannelRoutingInput,
): Promise<EmailChannelRoutingInput> {
  const [project] = await tx
    .select({ id: projects.id })
    .from(projects)
    .where(and(eq(projects.organizationId, organizationId), eq(projects.id, projectId)))
    .limit(1);
  if (!project) throw new EmailChannelInputError({ projectId: ['Project not found.'] });
  if (!input.notifyOnIncident && !input.notifyOnRecovery)
    throw new EmailChannelInputError({ routing: ['Choose at least one incident event.'] });
  const monitorIds = [...new Set(input.monitorIds.map((id) => id.toLowerCase()))];
  if (monitorIds.length !== input.monitorIds.length)
    throw new EmailChannelInputError({ monitorIds: ['Monitor IDs must be unique.'] });
  if (monitorIds.length > 500)
    throw new EmailChannelInputError({ monitorIds: ['At most 500 monitors can be routed.'] });
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
      throw new EmailChannelInputError({
        monitorIds: ['Every monitor must belong to the selected project.'],
      });
  }
  return { ...input, monitorIds };
}

async function replaceRouting(
  tx: Transaction,
  organizationId: string,
  channelId: string,
  routing: EmailChannelRoutingInput,
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
): Promise<EmailChannelRoutingInput> {
  const [channel] = await db
    .select({
      notifyOnIncident: webhookEndpoints.notifyOnIncident,
      notifyOnRecovery: webhookEndpoints.notifyOnRecovery,
    })
    .from(webhookEndpoints)
    .where(
      and(
        eq(webhookEndpoints.organizationId, organizationId),
        eq(webhookEndpoints.id, channelId),
        eq(webhookEndpoints.channelType, 'EMAIL'),
      ),
    )
    .limit(1);
  if (!channel) throw new EmailChannelNotFoundError();
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
    throw new EmailChannelInputError({ name: ['Name must contain 1 to 120 characters.'] });
  return name;
}

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && (codePoint < 32 || codePoint === 127);
  });
}

function parseRecipients(values: string[]): string[] {
  const recipients = [...new Set(values.map((value) => value.trim().toLowerCase()))];
  if (recipients.length !== values.length || recipients.length < 1 || recipients.length > 20)
    throw new EmailChannelInputError({
      recipientEmails: ['Provide 1 to 20 unique recipient email addresses.'],
    });
  if (recipients.some((value) => value.length > 320 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(value)))
    throw new EmailChannelInputError({
      recipientEmails: ['Every recipient must be a valid email address.'],
    });
  return recipients;
}

function emailRecipients(value: string[] | null): string[] {
  if (!value) throw new Error('Email channel version is missing recipients.');
  return value;
}

function requiredProjectId(value: string | null): string {
  if (!value) throw new Error('Email channel is missing its project.');
  return value;
}

function sameStrings(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function toRecord(
  channel: typeof webhookEndpoints.$inferSelect,
  versionNumber: number,
  recipientEmails: string[],
  routing: EmailChannelRoutingInput,
): EmailChannelRecord {
  return {
    id: channel.id,
    organizationId: channel.organizationId,
    projectId: requiredProjectId(channel.projectId),
    name: channel.name,
    enabled: channel.enabled,
    versionNumber,
    recipientEmails,
    createdAt: channel.createdAt,
    updatedAt: channel.updatedAt,
    routing,
  };
}
