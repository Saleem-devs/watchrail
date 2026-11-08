import { and, desc, eq, or, sql } from 'drizzle-orm';
import type { DnsRecordType } from '@watchrail/domain';
import type { WatchrailDatabase } from './client.js';
import {
  dnsRecordChanges,
  dnsRecordHistoryState,
  monitors,
  type DnsRecordLocationEvidence,
} from './schema.js';

type Transaction = Parameters<Parameters<WatchrailDatabase['transaction']>[0]>[0];

const RETAINED_CHANGES_PER_MONITOR = 500;
const COMPARABLE_DNS_REASONS = new Set(['RECORDS_MATCHED', 'RECORD_MISMATCH', 'NO_RECORDS']);

export interface DnsRecordObservation {
  organizationId: string;
  monitorId: string;
  configurationVersionId: string;
  roundId: string;
  roundCreatedAt: Date;
  observedAt: Date;
  dnsName: string;
  recordType: DnsRecordType;
  answers: readonly string[];
  locations: readonly DnsRecordLocationEvidence[];
}

export interface DnsRecordChangeHistoryItem {
  id: string;
  dnsName: string;
  recordType: DnsRecordType;
  beforeAnswers: string[];
  afterAnswers: string[];
  beforeLocationEvidence: DnsRecordLocationEvidence[];
  afterLocationEvidence: DnsRecordLocationEvidence[];
  detectedAt: Date;
  confirmedAt: Date;
  configurationVersionId: string;
}

export interface DnsRecordHistoryPage {
  current: {
    dnsName: string;
    recordType: DnsRecordType;
    answers: string[];
    locationEvidence: DnsRecordLocationEvidence[];
    observedAt: Date;
    configurationVersionId: string;
  } | null;
  candidate: {
    answers: string[];
    locationEvidence: DnsRecordLocationEvidence[];
    firstObservedAt: Date;
  } | null;
  items: DnsRecordChangeHistoryItem[];
  nextCursor: string | null;
}

export interface DnsRecordHistoryQuery {
  limit: number;
  cursor?: string;
}

export function isComparableDnsEvidence(stage: string, reason: string): boolean {
  return stage === 'DNS' && COMPARABLE_DNS_REASONS.has(reason);
}

export async function applyDnsRecordObservation(
  tx: Transaction,
  rawObservation: DnsRecordObservation,
): Promise<void> {
  const observation = normalizeObservation(rawObservation);
  await lockMonitor(tx, observation.organizationId, observation.monitorId);
  const [state] = await tx
    .select()
    .from(dnsRecordHistoryState)
    .where(
      and(
        eq(dnsRecordHistoryState.organizationId, observation.organizationId),
        eq(dnsRecordHistoryState.monitorId, observation.monitorId),
      ),
    )
    .limit(1)
    .for('update');

  if (!state) {
    await tx.insert(dnsRecordHistoryState).values({
      organizationId: observation.organizationId,
      monitorId: observation.monitorId,
      configurationVersionId: observation.configurationVersionId,
      dnsName: observation.dnsName,
      recordType: observation.recordType,
      baselineAnswers: observation.answers,
      baselineLocationEvidence: observation.locations,
      baselineObservedAt: observation.observedAt,
      baselineRoundId: observation.roundId,
      lastProcessedRoundCreatedAt: observation.roundCreatedAt,
      lastProcessedRoundId: observation.roundId,
      updatedAt: sql`clock_timestamp()`,
    });
    return;
  }

  if (!isLaterRound(observation, state)) return;

  const watermark = {
    lastProcessedRoundCreatedAt: observation.roundCreatedAt,
    lastProcessedRoundId: observation.roundId,
    updatedAt: sql`clock_timestamp()`,
  };
  const comparisonScopeChanged =
    state.dnsName !== observation.dnsName ||
    state.recordType !== observation.recordType ||
    !sameLocationScope(state.baselineLocationEvidence, observation.locations);
  if (comparisonScopeChanged) {
    await tx
      .update(dnsRecordHistoryState)
      .set({
        ...watermark,
        configurationVersionId: observation.configurationVersionId,
        dnsName: observation.dnsName,
        recordType: observation.recordType,
        baselineAnswers: observation.answers,
        baselineLocationEvidence: observation.locations,
        baselineObservedAt: observation.observedAt,
        baselineRoundId: observation.roundId,
        candidateAnswers: null,
        candidateLocationEvidence: null,
        candidateFirstObservedAt: null,
        candidateRoundId: null,
      })
      .where(eq(dnsRecordHistoryState.monitorId, observation.monitorId));
    return;
  }

  if (sameSnapshot(state.baselineLocationEvidence, observation.locations)) {
    await tx
      .update(dnsRecordHistoryState)
      .set({
        ...watermark,
        configurationVersionId: observation.configurationVersionId,
        dnsName: observation.dnsName,
        recordType: observation.recordType,
        baselineObservedAt: observation.observedAt,
        baselineRoundId: observation.roundId,
        candidateAnswers: null,
        candidateLocationEvidence: null,
        candidateFirstObservedAt: null,
        candidateRoundId: null,
      })
      .where(eq(dnsRecordHistoryState.monitorId, observation.monitorId));
    return;
  }

  if (
    !state.candidateLocationEvidence ||
    !sameSnapshot(state.candidateLocationEvidence, observation.locations)
  ) {
    await tx
      .update(dnsRecordHistoryState)
      .set({
        ...watermark,
        configurationVersionId: observation.configurationVersionId,
        dnsName: observation.dnsName,
        recordType: observation.recordType,
        candidateAnswers: observation.answers,
        candidateLocationEvidence: observation.locations,
        candidateFirstObservedAt: observation.observedAt,
        candidateRoundId: observation.roundId,
      })
      .where(eq(dnsRecordHistoryState.monitorId, observation.monitorId));
    return;
  }

  if (!state.candidateFirstObservedAt || !state.candidateRoundId || !state.candidateAnswers) {
    throw new Error('DNS record history candidate state is incomplete.');
  }
  await tx
    .insert(dnsRecordChanges)
    .values({
      organizationId: observation.organizationId,
      monitorId: observation.monitorId,
      configurationVersionId: observation.configurationVersionId,
      dnsName: observation.dnsName,
      recordType: observation.recordType,
      beforeAnswers: state.baselineAnswers,
      afterAnswers: observation.answers,
      beforeLocationEvidence: state.baselineLocationEvidence,
      afterLocationEvidence: observation.locations,
      detectedAt: state.candidateFirstObservedAt,
      confirmedAt: observation.observedAt,
      firstObservedRoundId: state.candidateRoundId,
      confirmedRoundId: observation.roundId,
    })
    .onConflictDoNothing();
  await tx
    .update(dnsRecordHistoryState)
    .set({
      ...watermark,
      configurationVersionId: observation.configurationVersionId,
      dnsName: observation.dnsName,
      recordType: observation.recordType,
      baselineAnswers: observation.answers,
      baselineLocationEvidence: observation.locations,
      baselineObservedAt: observation.observedAt,
      baselineRoundId: observation.roundId,
      candidateAnswers: null,
      candidateLocationEvidence: null,
      candidateFirstObservedAt: null,
      candidateRoundId: null,
    })
    .where(eq(dnsRecordHistoryState.monitorId, observation.monitorId));
  await tx.execute(sql`
    delete from ${dnsRecordChanges}
    where ${dnsRecordChanges.organizationId} = ${observation.organizationId}
      and ${dnsRecordChanges.monitorId} = ${observation.monitorId}
      and ${dnsRecordChanges.id} in (
        select ${dnsRecordChanges.id}
        from ${dnsRecordChanges}
        where ${dnsRecordChanges.organizationId} = ${observation.organizationId}
          and ${dnsRecordChanges.monitorId} = ${observation.monitorId}
        order by ${dnsRecordChanges.confirmedAt} desc, ${dnsRecordChanges.id} desc
        offset ${RETAINED_CHANGES_PER_MONITOR}
      )
  `);
}

export async function clearDnsRecordCandidate(
  tx: Transaction,
  input: {
    organizationId: string;
    monitorId: string;
    roundId: string;
    roundCreatedAt: Date;
  },
): Promise<void> {
  await lockMonitor(tx, input.organizationId, input.monitorId);
  const [state] = await tx
    .select()
    .from(dnsRecordHistoryState)
    .where(
      and(
        eq(dnsRecordHistoryState.organizationId, input.organizationId),
        eq(dnsRecordHistoryState.monitorId, input.monitorId),
      ),
    )
    .limit(1)
    .for('update');
  if (!state || !isLaterRound(input, state)) return;
  await tx
    .update(dnsRecordHistoryState)
    .set({
      candidateAnswers: null,
      candidateLocationEvidence: null,
      candidateFirstObservedAt: null,
      candidateRoundId: null,
      lastProcessedRoundCreatedAt: input.roundCreatedAt,
      lastProcessedRoundId: input.roundId,
      updatedAt: sql`clock_timestamp()`,
    })
    .where(eq(dnsRecordHistoryState.monitorId, input.monitorId));
}

export class DnsRecordHistoryRepository {
  constructor(private readonly db: WatchrailDatabase) {}

  async listForMonitor(
    organizationId: string,
    monitorId: string,
    query: DnsRecordHistoryQuery,
  ): Promise<DnsRecordHistoryPage> {
    const [monitor] = await this.db
      .select({ type: monitors.type })
      .from(monitors)
      .where(and(eq(monitors.organizationId, organizationId), eq(monitors.id, monitorId)))
      .limit(1);
    if (!monitor || monitor.type !== 'DNS') throw new DnsRecordHistoryMonitorNotFoundError();

    const cursor = query.cursor ? decodeCursor(query.cursor) : undefined;
    const rows = await this.db
      .select()
      .from(dnsRecordChanges)
      .where(
        and(
          eq(dnsRecordChanges.organizationId, organizationId),
          eq(dnsRecordChanges.monitorId, monitorId),
          cursor
            ? or(
                sql`${dnsRecordChanges.confirmedAt} < ${cursor.confirmedAt}`,
                and(
                  eq(dnsRecordChanges.confirmedAt, cursor.confirmedAt),
                  sql`${dnsRecordChanges.id} < ${cursor.id}`,
                ),
              )
            : undefined,
        ),
      )
      .orderBy(desc(dnsRecordChanges.confirmedAt), desc(dnsRecordChanges.id))
      .limit(query.limit + 1);
    const [state] = await this.db
      .select()
      .from(dnsRecordHistoryState)
      .where(
        and(
          eq(dnsRecordHistoryState.organizationId, organizationId),
          eq(dnsRecordHistoryState.monitorId, monitorId),
        ),
      )
      .limit(1);
    const hasMore = rows.length > query.limit;
    const items = rows.slice(0, query.limit);
    const last = items.at(-1);
    return {
      current: state
        ? {
            dnsName: state.dnsName,
            recordType: state.recordType,
            answers: state.baselineAnswers,
            locationEvidence: state.baselineLocationEvidence,
            observedAt: state.baselineObservedAt,
            configurationVersionId: state.configurationVersionId,
          }
        : null,
      candidate:
        state?.candidateAnswers && state.candidateLocationEvidence && state.candidateFirstObservedAt
          ? {
              answers: state.candidateAnswers,
              locationEvidence: state.candidateLocationEvidence,
              firstObservedAt: state.candidateFirstObservedAt,
            }
          : null,
      items: items.map((item) => ({
        id: item.id,
        dnsName: item.dnsName,
        recordType: item.recordType,
        beforeAnswers: item.beforeAnswers,
        afterAnswers: item.afterAnswers,
        beforeLocationEvidence: item.beforeLocationEvidence,
        afterLocationEvidence: item.afterLocationEvidence,
        detectedAt: item.detectedAt,
        confirmedAt: item.confirmedAt,
        configurationVersionId: item.configurationVersionId,
      })),
      nextCursor:
        hasMore && last ? encodeCursor({ confirmedAt: last.confirmedAt, id: last.id }) : null,
    };
  }
}

export function parseDnsRecordHistoryQuery(value: Record<string, unknown>): DnsRecordHistoryQuery {
  const supported = new Set(['limit', 'cursor']);
  if (Object.keys(value).some((key) => !supported.has(key))) {
    throw new DnsRecordHistoryQueryError(
      'DNS record history query contains unsupported parameters.',
    );
  }
  const rawLimit = value.limit;
  const limit = rawLimit === undefined ? 25 : Number(rawLimit);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new DnsRecordHistoryQueryError(
      'DNS record history limit must be an integer from 1 to 100.',
    );
  }
  const cursor = value.cursor;
  if (cursor !== undefined && (typeof cursor !== 'string' || cursor.length > 512)) {
    throw new DnsRecordHistoryQueryError('DNS record history cursor is invalid.');
  }
  if (cursor) decodeCursor(cursor);
  return { limit, ...(cursor ? { cursor } : {}) };
}

export class DnsRecordHistoryMonitorNotFoundError extends Error {
  constructor() {
    super('DNS monitor not found.');
    this.name = 'DnsRecordHistoryMonitorNotFoundError';
  }
}

export class DnsRecordHistoryQueryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DnsRecordHistoryQueryError';
  }
}

function normalizeObservation(observation: DnsRecordObservation): Omit<
  DnsRecordObservation,
  'answers' | 'locations'
> & {
  answers: string[];
  locations: DnsRecordLocationEvidence[];
} {
  const locations = [...observation.locations]
    .map((item) => ({
      location: item.location,
      answers: [...new Set(item.answers)].sort(),
    }))
    .sort((left, right) => left.location.localeCompare(right.location));
  return {
    ...observation,
    answers: [...new Set(observation.answers)].sort(),
    locations,
  };
}

function sameSnapshot(
  left: readonly DnsRecordLocationEvidence[],
  right: readonly DnsRecordLocationEvidence[],
): boolean {
  return (
    left.length === right.length &&
    left.every(
      (item, index) =>
        item.location === right[index]?.location &&
        item.answers.length === right[index]?.answers.length &&
        item.answers.every((answer, answerIndex) => answer === right[index]?.answers[answerIndex]),
    )
  );
}

function sameLocationScope(
  left: readonly DnsRecordLocationEvidence[],
  right: readonly DnsRecordLocationEvidence[],
): boolean {
  return (
    left.length === right.length &&
    left.every((item, index) => item.location === right[index]?.location)
  );
}

async function lockMonitor(
  tx: Transaction,
  organizationId: string,
  monitorId: string,
): Promise<void> {
  const [monitor] = await tx
    .select({ id: monitors.id })
    .from(monitors)
    .where(and(eq(monitors.organizationId, organizationId), eq(monitors.id, monitorId)))
    .limit(1)
    .for('update');
  if (!monitor) throw new Error('DNS history monitor is missing.');
}

function isLaterRound(
  input: { roundCreatedAt: Date; roundId: string },
  state: {
    lastProcessedRoundCreatedAt: Date;
    lastProcessedRoundId: string;
  },
): boolean {
  return (
    input.roundCreatedAt > state.lastProcessedRoundCreatedAt ||
    (input.roundCreatedAt.getTime() === state.lastProcessedRoundCreatedAt.getTime() &&
      input.roundId > state.lastProcessedRoundId)
  );
}

function encodeCursor(cursor: { confirmedAt: Date; id: string }): string {
  return Buffer.from(
    JSON.stringify({ confirmedAt: cursor.confirmedAt.toISOString(), id: cursor.id }),
  ).toString('base64url');
}

function decodeCursor(value: string): { confirmedAt: Date; id: string } {
  try {
    const decoded = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as {
      confirmedAt?: unknown;
      id?: unknown;
    };
    if (typeof decoded.confirmedAt !== 'string' || typeof decoded.id !== 'string')
      throw new Error();
    const confirmedAt = new Date(decoded.confirmedAt);
    if (
      !Number.isFinite(confirmedAt.getTime()) ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(decoded.id)
    ) {
      throw new Error();
    }
    return { confirmedAt, id: decoded.id };
  } catch {
    throw new DnsRecordHistoryQueryError('DNS record history cursor is invalid.');
  }
}
