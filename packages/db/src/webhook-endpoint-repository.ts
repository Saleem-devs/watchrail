import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import {
  parseStoredWebhookSigningSecret,
  type EncryptedWebhookSigningSecretV1,
} from '@watchrail/webhook-security';
import type { WatchrailDatabase } from './client.js';
import { webhookEndpoints, webhookEndpointVersions } from './schema.js';

type Transaction = Parameters<Parameters<WatchrailDatabase['transaction']>[0]>[0];

export interface WebhookEndpointRecord {
  id: string;
  organizationId: string;
  name: string;
  enabled: boolean;
  versionNumber: number;
  url: string;
  createdAt: Date;
  updatedAt: Date;
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
    input: { name: string; url: string; enabled?: boolean },
    createEnvelope: (context: WebhookEndpointVersionContext) => EncryptedWebhookSigningSecretV1,
  ): Promise<WebhookEndpointRecord> {
    const settings = parseSettings(input.name, input.url);
    const endpointId = randomUUID();
    return this.db.transaction(async (tx) => {
      const envelope = parseStoredWebhookSigningSecret(
        createEnvelope({ endpointId, versionNumber: 1 }),
      );
      const [endpoint] = await tx
        .insert(webhookEndpoints)
        .values({
          id: endpointId,
          organizationId,
          name: settings.name,
          enabled: input.enabled ?? true,
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
      return toRecord(endpoint, 1, settings.url);
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
              url: current.version.url,
              signingSecretEnvelope: parseStoredWebhookSigningSecret(
                current.version.signingSecretEnvelope,
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
      return toRecord(endpoint, nextVersionNumber, settings.url);
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
        return toRecord(current.endpoint, current.version.versionNumber, current.version.url);
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
      return toRecord(endpoint, current.version.versionNumber, current.version.url);
    });
  }

  async listForOrganization(organizationId: string): Promise<WebhookEndpointRecord[]> {
    const rows = await this.currentQuery(this.db, organizationId);
    return rows.map((row) => toRecord(row.endpoint, row.version.versionNumber, row.version.url));
  }

  async findForOrganization(
    organizationId: string,
    endpointId: string,
  ): Promise<WebhookEndpointRecord | null> {
    const rows = await this.currentQuery(this.db, organizationId, endpointId);
    const row = rows[0];
    return row ? toRecord(row.endpoint, row.version.versionNumber, row.version.url) : null;
  }

  private currentQuery(db: WatchrailDatabase, organizationId: string, endpointId?: string) {
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
          endpointId === undefined ? undefined : eq(webhookEndpoints.id, endpointId),
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
): WebhookEndpointRecord {
  return {
    id: endpoint.id,
    organizationId: endpoint.organizationId,
    name: endpoint.name,
    enabled: endpoint.enabled,
    versionNumber,
    url,
    createdAt: endpoint.createdAt,
    updatedAt: endpoint.updatedAt,
  };
}
