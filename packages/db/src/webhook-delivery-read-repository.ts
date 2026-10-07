import { Buffer } from 'node:buffer';
import { and, desc, eq, lt, or, sql } from 'drizzle-orm';
import type { WatchrailDatabase } from './client.js';
import { notificationDeliveries, notificationEvents, webhookEndpointVersions } from './schema.js';

export type WebhookDeliveryStatus =
  'PENDING' | 'IN_FLIGHT' | 'RETRY_SCHEDULED' | 'DELIVERED' | 'DEAD';

export interface WebhookDeliveryListItem {
  id: string;
  event: {
    id: string;
    type: 'INCIDENT_OPENED' | 'INCIDENT_RESOLVED';
    occurredAt: Date;
    monitorId: string;
    incidentId: string;
  };
  status: WebhookDeliveryStatus;
  attemptCount: number;
  lastAttemptAt: Date | null;
  lastErrorCode: string | null;
  lastHttpStatus: number | null;
  nextAttemptAt: Date | null;
  leaseExpiresAt: Date | null;
  deliveredAt: Date | null;
  deadAt: Date | null;
  deadReason: string | null;
  createdAt: Date;
}

export interface WebhookDeliveryDetail extends WebhookDeliveryListItem {
  endpointId: string;
  endpointVersion: {
    id: string;
    versionNumber: number;
    url: string;
  };
  triggeringRoundId: string;
}

export interface WebhookDeliveryPage {
  items: WebhookDeliveryListItem[];
  nextCursor: string | null;
}

export interface WebhookDeliveryHistoryQuery {
  limit: number;
  cursor?: string;
}

interface WebhookDeliveryCursorV1 {
  contractVersion: 1;
  createdAt: string;
  deliveryId: string;
}

interface DeliveryRow {
  id: string;
  endpointId: string;
  endpointVersionId: string;
  availableAt: Date;
  claimToken: string | null;
  attemptCount: number;
  lastAttemptAt: Date | null;
  lastErrorCode: string | null;
  lastHttpStatus: number | null;
  deliveredAt: Date | null;
  deadAt: Date | null;
  deadReason: string | null;
  createdAt: Date;
  eventId: string;
  eventType: 'INCIDENT_OPENED' | 'INCIDENT_RESOLVED';
  occurredAt: Date;
  monitorId: string;
  incidentId: string;
  triggeringRoundId: string;
}

export class WebhookDeliveryReadRepository {
  constructor(private readonly db: WatchrailDatabase) {}

  async listForEndpoint(
    organizationId: string,
    endpointId: string,
    query: WebhookDeliveryHistoryQuery,
  ): Promise<WebhookDeliveryPage> {
    const cutoff = await this.endpointCutoff(organizationId, endpointId);
    const cursor = query.cursor ? decodeCursor(query.cursor) : undefined;
    const cursorDate = cursor ? new Date(cursor.createdAt) : undefined;
    const rows = await this.db
      .select(deliverySelection)
      .from(notificationDeliveries)
      .innerJoin(
        notificationEvents,
        and(
          eq(notificationEvents.organizationId, notificationDeliveries.organizationId),
          eq(notificationEvents.id, notificationDeliveries.eventId),
        ),
      )
      .where(
        and(
          eq(notificationDeliveries.organizationId, organizationId),
          eq(notificationDeliveries.endpointId, endpointId),
          cursor && cursorDate
            ? or(
                lt(notificationDeliveries.createdAt, cursorDate),
                and(
                  eq(notificationDeliveries.createdAt, cursorDate),
                  lt(notificationDeliveries.id, cursor.deliveryId),
                ),
              )
            : undefined,
        ),
      )
      .orderBy(desc(notificationDeliveries.createdAt), desc(notificationDeliveries.id))
      .limit(query.limit + 1);
    const hasNext = rows.length > query.limit;
    const pageRows = hasNext ? rows.slice(0, query.limit) : rows;
    const last = pageRows.at(-1);
    return {
      items: pageRows.map((row) => toListItem(row, cutoff)),
      nextCursor:
        hasNext && last
          ? encodeCursor({
              contractVersion: 1,
              createdAt: last.createdAt.toISOString(),
              deliveryId: last.id,
            })
          : null,
    };
  }

  async findForEndpoint(
    organizationId: string,
    endpointId: string,
    deliveryId: string,
  ): Promise<WebhookDeliveryDetail | null> {
    const cutoff = await this.endpointCutoff(organizationId, endpointId);
    const [row] = await this.db
      .select({
        ...deliverySelection,
        endpointVersionNumber: webhookEndpointVersions.versionNumber,
        endpointVersionUrl: webhookEndpointVersions.url,
      })
      .from(notificationDeliveries)
      .innerJoin(
        notificationEvents,
        and(
          eq(notificationEvents.organizationId, notificationDeliveries.organizationId),
          eq(notificationEvents.id, notificationDeliveries.eventId),
        ),
      )
      .innerJoin(
        webhookEndpointVersions,
        and(
          eq(webhookEndpointVersions.organizationId, notificationDeliveries.organizationId),
          eq(webhookEndpointVersions.endpointId, notificationDeliveries.endpointId),
          eq(webhookEndpointVersions.id, notificationDeliveries.endpointVersionId),
        ),
      )
      .where(
        and(
          eq(notificationDeliveries.organizationId, organizationId),
          eq(notificationDeliveries.endpointId, endpointId),
          eq(notificationDeliveries.id, deliveryId),
        ),
      )
      .limit(1);
    if (!row) return null;
    return {
      ...toListItem(row, cutoff),
      endpointId: row.endpointId,
      endpointVersion: {
        id: row.endpointVersionId,
        versionNumber: row.endpointVersionNumber,
        url: row.endpointVersionUrl,
      },
      triggeringRoundId: row.triggeringRoundId,
    };
  }

  private async endpointCutoff(organizationId: string, endpointId: string): Promise<Date> {
    const result = await this.db.execute<{ cutoff: Date | string }>(sql`
      select clock_timestamp() as cutoff
      from webhook_endpoints
      where organization_id=${organizationId}::uuid and id=${endpointId}::uuid
      limit 1
    `);
    const row = result.rows[0];
    if (!row) throw new WebhookDeliveryEndpointNotFoundError();
    return row.cutoff instanceof Date ? row.cutoff : new Date(row.cutoff);
  }
}

const deliverySelection = {
  id: notificationDeliveries.id,
  endpointId: notificationDeliveries.endpointId,
  endpointVersionId: notificationDeliveries.endpointVersionId,
  availableAt: notificationDeliveries.availableAt,
  claimToken: notificationDeliveries.claimToken,
  attemptCount: notificationDeliveries.attemptCount,
  lastAttemptAt: notificationDeliveries.lastAttemptAt,
  lastErrorCode: notificationDeliveries.lastErrorCode,
  lastHttpStatus: notificationDeliveries.lastHttpStatus,
  deliveredAt: notificationDeliveries.deliveredAt,
  deadAt: notificationDeliveries.deadAt,
  deadReason: notificationDeliveries.deadReason,
  createdAt: notificationDeliveries.createdAt,
  eventId: notificationEvents.id,
  eventType: notificationEvents.eventType,
  occurredAt: notificationEvents.occurredAt,
  monitorId: notificationEvents.monitorId,
  incidentId: notificationEvents.incidentId,
  triggeringRoundId: notificationEvents.triggeringRoundId,
};

function toListItem(row: DeliveryRow, cutoff: Date): WebhookDeliveryListItem {
  const status = deriveStatus(row, cutoff);
  return {
    id: row.id,
    event: {
      id: row.eventId,
      type: row.eventType,
      occurredAt: row.occurredAt,
      monitorId: row.monitorId,
      incidentId: row.incidentId,
    },
    status,
    attemptCount: row.attemptCount,
    lastAttemptAt: row.lastAttemptAt,
    lastErrorCode: row.lastErrorCode,
    lastHttpStatus: row.lastHttpStatus,
    nextAttemptAt: status === 'RETRY_SCHEDULED' ? row.availableAt : null,
    leaseExpiresAt: status === 'IN_FLIGHT' ? row.availableAt : null,
    deliveredAt: row.deliveredAt,
    deadAt: row.deadAt,
    deadReason: row.deadReason,
    createdAt: row.createdAt,
  };
}

function deriveStatus(
  row: Pick<DeliveryRow, 'deliveredAt' | 'deadAt' | 'claimToken' | 'attemptCount' | 'availableAt'>,
  cutoff: Date,
): WebhookDeliveryStatus {
  if (row.deliveredAt !== null) return 'DELIVERED';
  if (row.deadAt !== null) return 'DEAD';
  if (row.claimToken !== null && row.availableAt > cutoff) return 'IN_FLIGHT';
  if (row.claimToken === null && row.attemptCount > 0 && row.availableAt > cutoff)
    return 'RETRY_SCHEDULED';
  return 'PENDING';
}

export class WebhookDeliveryEndpointNotFoundError extends Error {
  constructor() {
    super('Webhook endpoint not found.');
    this.name = 'WebhookDeliveryEndpointNotFoundError';
  }
}

export class WebhookDeliveryHistoryQueryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WebhookDeliveryHistoryQueryError';
  }
}

export function parseWebhookDeliveryHistoryQuery(
  value: Record<string, unknown>,
): WebhookDeliveryHistoryQuery {
  if (Object.keys(value).some((key) => !['cursor', 'limit'].includes(key)))
    throw new WebhookDeliveryHistoryQueryError(
      'Webhook delivery history query contains unsupported parameters.',
    );
  const rawLimit = value.limit;
  const limit = rawLimit === undefined ? 25 : Number(rawLimit);
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 100 ||
    (rawLimit !== undefined && (typeof rawLimit !== 'string' || String(limit) !== rawLimit))
  )
    throw new WebhookDeliveryHistoryQueryError(
      'Webhook delivery history limit must be an integer from 1 to 100.',
    );
  if (value.cursor !== undefined) {
    if (typeof value.cursor !== 'string' || value.cursor.length === 0)
      throw new WebhookDeliveryHistoryQueryError('Webhook delivery history cursor is invalid.');
    decodeCursor(value.cursor);
  }
  return {
    limit,
    ...(typeof value.cursor === 'string' ? { cursor: value.cursor } : {}),
  };
}

function encodeCursor(cursor: WebhookDeliveryCursorV1): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

function decodeCursor(value: string): WebhookDeliveryCursorV1 {
  try {
    const bytes = Buffer.from(value, 'base64url');
    if (bytes.toString('base64url') !== value) throw new Error();
    const decoded: unknown = JSON.parse(bytes.toString('utf8'));
    if (!isRecord(decoded)) throw new Error();
    const keys = Object.keys(decoded).sort();
    if (
      keys.length !== 3 ||
      keys[0] !== 'contractVersion' ||
      keys[1] !== 'createdAt' ||
      keys[2] !== 'deliveryId' ||
      decoded.contractVersion !== 1 ||
      typeof decoded.createdAt !== 'string' ||
      new Date(decoded.createdAt).toISOString() !== decoded.createdAt ||
      typeof decoded.deliveryId !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
        decoded.deliveryId,
      )
    )
      throw new Error();
    return decoded as unknown as WebhookDeliveryCursorV1;
  } catch {
    throw new WebhookDeliveryHistoryQueryError('Webhook delivery history cursor is invalid.');
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
