import { and, eq, sql } from 'drizzle-orm';
import type { WatchrailDatabase } from './client.js';
import {
  webhookEndpoints,
  webhookEndpointVersions,
  type WebhookSigningSecretEnvelopeV1,
} from './schema.js';

export class WebhookEndpointRepository {
  constructor(private readonly db: WatchrailDatabase) {}

  async create(
    organizationId: string,
    input: {
      name: string;
      url: string;
      signingSecretEnvelope: WebhookSigningSecretEnvelopeV1;
      enabled?: boolean;
    },
  ) {
    assertEndpointInput(input);
    return this.db.transaction(async (tx) => {
      const [endpoint] = await tx
        .insert(webhookEndpoints)
        .values({ organizationId, name: input.name.trim(), enabled: input.enabled ?? true })
        .returning();
      if (!endpoint) throw new Error('Webhook endpoint creation returned no record.');
      const [version] = await tx
        .insert(webhookEndpointVersions)
        .values({
          organizationId,
          endpointId: endpoint.id,
          versionNumber: 1,
          url: input.url,
          signingSecretEnvelope: input.signingSecretEnvelope,
        })
        .returning();
      if (!version) throw new Error('Webhook endpoint version creation returned no record.');
      return { endpoint, version };
    });
  }

  async update(
    organizationId: string,
    endpointId: string,
    input: { url: string; signingSecretEnvelope: WebhookSigningSecretEnvelopeV1 },
  ) {
    assertEndpointInput({ name: 'retained', ...input });
    return this.db.transaction(async (tx) => {
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
      if (!endpoint) throw new Error('Webhook endpoint not found.');
      const next = endpoint.currentVersionNumber + 1;
      const [version] = await tx
        .insert(webhookEndpointVersions)
        .values({
          organizationId,
          endpointId,
          versionNumber: next,
          url: input.url,
          signingSecretEnvelope: input.signingSecretEnvelope,
        })
        .returning();
      await tx
        .update(webhookEndpoints)
        .set({ currentVersionNumber: next, updatedAt: sql`clock_timestamp()` })
        .where(
          and(
            eq(webhookEndpoints.organizationId, organizationId),
            eq(webhookEndpoints.id, endpointId),
          ),
        );
      return version!;
    });
  }

  async setEnabled(organizationId: string, endpointId: string, enabled: boolean) {
    const [endpoint] = await this.db
      .update(webhookEndpoints)
      .set({ enabled, updatedAt: sql`clock_timestamp()` })
      .where(
        and(
          eq(webhookEndpoints.organizationId, organizationId),
          eq(webhookEndpoints.id, endpointId),
        ),
      )
      .returning();
    if (!endpoint) throw new Error('Webhook endpoint not found.');
    return endpoint;
  }
}

function assertEndpointInput(input: {
  name: string;
  url: string;
  signingSecretEnvelope: WebhookSigningSecretEnvelopeV1;
}) {
  if (!input.name.trim() || input.name.length > 120)
    throw new RangeError('Webhook endpoint name is invalid.');
  if (input.url.length > 2048) throw new RangeError('Webhook endpoint URL is invalid.');
  let url: URL;
  try {
    url = new URL(input.url);
  } catch {
    throw new RangeError('Webhook endpoint URL is invalid.');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || !url.hostname)
    throw new RangeError('Webhook endpoint URL is invalid.');
  const envelope = input.signingSecretEnvelope;
  if (
    envelope.version !== 1 ||
    envelope.algorithm !== 'AES-256-GCM' ||
    !envelope.keyId ||
    !envelope.iv ||
    !envelope.ciphertext ||
    !envelope.authTag
  )
    throw new RangeError('Webhook signing-secret envelope is invalid.');
}
