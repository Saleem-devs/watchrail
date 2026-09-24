import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { WatchrailDatabase } from './client.js';

export const OUTBOX_PUBLICATION_ERROR_CODES = [
  'REDIS_UNAVAILABLE',
  'QUEUE_PUBLICATION_TIMEOUT',
  'QUEUE_PUBLICATION_REJECTED',
] as const;

export const OUTBOX_BLOCK_REASONS = ['INVALID_CONTRACT'] as const;

export type OutboxPublicationErrorCode = (typeof OUTBOX_PUBLICATION_ERROR_CODES)[number];
export type OutboxBlockReason = (typeof OUTBOX_BLOCK_REASONS)[number];

export interface ClaimedCheckRoundOutboxEvent {
  id: string;
  roundId: string;
  payload: unknown;
  createdAt: Date;
  availableAt: Date;
  claimToken: string;
  attemptCount: number;
  lastAttemptAt: Date;
  lastErrorCode: string | null;
  blockedAt: Date | null;
  blockedReason: string | null;
  publishedAt: Date | null;
}

interface ClaimedCheckRoundOutboxRow extends Record<string, unknown> {
  id: string;
  roundId: string;
  payload: unknown;
  createdAt: string;
  availableAt: string;
  claimToken: string;
  attemptCount: number;
  lastAttemptAt: string;
  lastErrorCode: string | null;
  blockedAt: string | null;
  blockedReason: string | null;
  publishedAt: string | null;
}

export class CheckRoundOutboxRepository {
  constructor(private readonly db: WatchrailDatabase) {}

  async claimNext(leaseDurationMs = 30_000): Promise<ClaimedCheckRoundOutboxEvent | null> {
    assertPositiveMilliseconds(leaseDurationMs, 'leaseDurationMs');

    const claimToken = randomUUID();

    const result = await this.db.execute<ClaimedCheckRoundOutboxRow>(sql`
      with candidate as (
        select id
        from check_round_outbox
        where published_at is null
          and blocked_at is null
          and available_at <= now()
        order by available_at, created_at, id
        for update skip locked
        limit 1
      )
      update check_round_outbox as outbox
      set
        claim_token = ${claimToken}::uuid,
        available_at = now() + (${leaseDurationMs} * interval '1 millisecond'),
        attempt_count = outbox.attempt_count + 1,
        last_attempt_at = now()
      from candidate
      where outbox.id = candidate.id
      returning
        outbox.id,
        outbox.round_id as "roundId",
        outbox.payload,
        outbox.created_at as "createdAt",
        outbox.available_at as "availableAt",
        outbox.claim_token as "claimToken",
        outbox.attempt_count as "attemptCount",
        outbox.last_attempt_at as "lastAttemptAt",
        outbox.last_error_code as "lastErrorCode",
        outbox.blocked_at as "blockedAt",
        outbox.blocked_reason as "blockedReason",
        outbox.published_at as "publishedAt"
    `);

    const row = result.rows[0];

    if (!row) return null;

    return {
      ...row,
      createdAt: parsePostgresTimestamp(row.createdAt),
      availableAt: parsePostgresTimestamp(row.availableAt),
      lastAttemptAt: parsePostgresTimestamp(row.lastAttemptAt),
      blockedAt: parseNullablePostgresTimestamp(row.blockedAt),
      publishedAt: parseNullablePostgresTimestamp(row.publishedAt),
    };
  }

  async acknowledgePublished(outboxId: string, claimToken: string): Promise<boolean> {
    const result = await this.db.execute<{ id: string }>(sql`
      update check_round_outbox
      set
        published_at = now(),
        claim_token = null,
        last_error_code = null
      where id = ${outboxId}::uuid
        and claim_token = ${claimToken}::uuid
        and published_at is null
        and blocked_at is null
      returning id
    `);

    return result.rowCount === 1;
  }

  async releaseForRetry(
    outboxId: string,
    claimToken: string,
    retryDelayMs: number,
    errorCode: OutboxPublicationErrorCode,
  ): Promise<boolean> {
    assertPositiveMilliseconds(retryDelayMs, 'retryDelayMs');

    const result = await this.db.execute<{ id: string }>(sql`
      update check_round_outbox
      set
        claim_token = null,
        available_at = now() + (${retryDelayMs} * interval '1 millisecond'),
        last_error_code = ${errorCode}
      where id = ${outboxId}::uuid
        and claim_token = ${claimToken}::uuid
        and published_at is null
        and blocked_at is null
      returning id
    `);

    return result.rowCount === 1;
  }

  async blockInvalid(
    outboxId: string,
    claimToken: string,
    reason: OutboxBlockReason = 'INVALID_CONTRACT',
  ): Promise<boolean> {
    const result = await this.db.execute<{ id: string }>(sql`
      update check_round_outbox
      set
        claim_token = null,
        blocked_at = now(),
        blocked_reason = ${reason}
      where id = ${outboxId}::uuid
        and claim_token = ${claimToken}::uuid
        and published_at is null
        and blocked_at is null
      returning id
    `);

    return result.rowCount === 1;
  }
}

function assertPositiveMilliseconds(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive safe integer.`);
  }
}

function parseNullablePostgresTimestamp(value: string | null): Date | null {
  return value === null ? null : parsePostgresTimestamp(value);
}

function parsePostgresTimestamp(value: string): Date {
  const parsed = new Date(value);

  if (Number.isNaN(parsed.getTime())) {
    throw new Error('PostgreSQL returned an invalid outbox timestamp.');
  }

  return parsed;
}
