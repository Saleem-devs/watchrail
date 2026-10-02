import { Buffer } from 'node:buffer';
import { and, asc, desc, eq, lt, or } from 'drizzle-orm';
import {
  parseHttpRedirectHops,
  parseStoredAssertionEvaluation,
  type AssertionEvaluationV1,
  type CheckRoundTrigger,
  type HttpRedirectHop,
} from '@watchrail/domain';
import type { WatchrailDatabase } from './client.js';
import {
  checkExecutionAssignments,
  checkExecutionResults,
  checkRounds,
  monitors,
  type CheckExecutionAssignmentRecord,
  type CheckExecutionResultRecord,
  type CheckRoundRecord,
} from './schema.js';

export type CurrentAvailability = 'AVAILABLE' | 'UNAVAILABLE' | 'UNKNOWN';

export interface CurrentCheck {
  availability: CurrentAvailability;
  responseTimeMs: number | null;
  checkedAt: Date;
  roundId: string;
  trigger: CheckRoundTrigger;
}

export interface CheckHistoryListItem {
  id: string;
  monitorId: string;
  trigger: CheckRoundTrigger;
  status: CheckRoundRecord['status'];
  assignmentStatus: CheckExecutionAssignmentRecord['status'];
  createdAt: Date;
  result: {
    outcome: CheckExecutionResultRecord['outcome'];
    stage: CheckExecutionResultRecord['stage'];
    reason: CheckExecutionResultRecord['reason'];
    statusCode: number | null;
    responseTimeMs: number | null;
    attemptDurationMs: number;
    assertionOutcome: AssertionEvaluationV1['outcome'];
    checkedAt: Date;
  } | null;
}

export interface CheckHistoryDetail extends Omit<CheckHistoryListItem, 'result'> {
  result: {
    outcome: CheckExecutionResultRecord['outcome'];
    stage: CheckExecutionResultRecord['stage'];
    reason: CheckExecutionResultRecord['reason'];
    statusCode: number | null;
    responseTimeMs: number | null;
    attemptDurationMs: number;
    redirects: HttpRedirectHop[];
    assertionEvaluation: AssertionEvaluationV1;
    checkedAt: Date;
  } | null;
}

export interface CheckHistoryPage {
  items: CheckHistoryListItem[];
  nextCursor: string | null;
}

export interface CheckHistoryQuery {
  limit: number;
  cursor?: string;
  trigger?: CheckRoundTrigger;
}

interface HistoryCursorV1 {
  contractVersion: 1;
  createdAt: string;
  roundId: string;
}

interface HistoryRow {
  id: string;
  monitorId: string;
  trigger: CheckRoundTrigger;
  status: CheckRoundRecord['status'];
  assignmentStatus: CheckExecutionAssignmentRecord['status'];
  createdAt: Date;
  resultId: string | null;
  outcome: CheckExecutionResultRecord['outcome'] | null;
  stage: CheckExecutionResultRecord['stage'] | null;
  reason: CheckExecutionResultRecord['reason'] | null;
  statusCode: number | null;
  responseTimeMs: number | null;
  attemptDurationMs: number | null;
  redirects: HttpRedirectHop[] | null;
  assertionEvaluation: AssertionEvaluationV1 | null;
  checkedAt: Date | null;
}

export class CheckHistoryRepository {
  constructor(private readonly db: WatchrailDatabase) {}

  async currentForOrganization(organizationId: string): Promise<Map<string, CurrentCheck>> {
    const rows = await this.db
      .selectDistinctOn([checkRounds.monitorId], {
        monitorId: checkRounds.monitorId,
        roundId: checkRounds.id,
        trigger: checkRounds.trigger,
        outcome: checkExecutionResults.outcome,
        responseTimeMs: checkExecutionResults.responseTimeMs,
        checkedAt: checkExecutionResults.checkedAt,
      })
      .from(checkRounds)
      .innerJoin(
        checkExecutionAssignments,
        and(
          eq(checkExecutionAssignments.organizationId, checkRounds.organizationId),
          eq(checkExecutionAssignments.roundId, checkRounds.id),
          eq(checkExecutionAssignments.location, 'local'),
        ),
      )
      .innerJoin(
        checkExecutionResults,
        and(
          eq(checkExecutionResults.organizationId, checkRounds.organizationId),
          eq(checkExecutionResults.roundId, checkRounds.id),
          eq(checkExecutionResults.assignmentId, checkExecutionAssignments.id),
        ),
      )
      .where(eq(checkRounds.organizationId, organizationId))
      .orderBy(asc(checkRounds.monitorId), desc(checkRounds.createdAt), desc(checkRounds.id));

    return new Map(
      rows.map((row) => [
        row.monitorId,
        {
          availability: availabilityFor(row.outcome),
          responseTimeMs: row.responseTimeMs,
          checkedAt: row.checkedAt,
          roundId: row.roundId,
          trigger: row.trigger,
        },
      ]),
    );
  }

  async currentForMonitor(organizationId: string, monitorId: string): Promise<CurrentCheck | null> {
    const [row] = await this.db
      .select({
        roundId: checkRounds.id,
        trigger: checkRounds.trigger,
        outcome: checkExecutionResults.outcome,
        responseTimeMs: checkExecutionResults.responseTimeMs,
        checkedAt: checkExecutionResults.checkedAt,
      })
      .from(checkRounds)
      .innerJoin(
        checkExecutionAssignments,
        and(
          eq(checkExecutionAssignments.organizationId, checkRounds.organizationId),
          eq(checkExecutionAssignments.roundId, checkRounds.id),
          eq(checkExecutionAssignments.location, 'local'),
        ),
      )
      .innerJoin(
        checkExecutionResults,
        and(
          eq(checkExecutionResults.organizationId, checkRounds.organizationId),
          eq(checkExecutionResults.roundId, checkRounds.id),
          eq(checkExecutionResults.assignmentId, checkExecutionAssignments.id),
        ),
      )
      .where(
        and(eq(checkRounds.organizationId, organizationId), eq(checkRounds.monitorId, monitorId)),
      )
      .orderBy(desc(checkRounds.createdAt), desc(checkRounds.id))
      .limit(1);

    return row
      ? {
          availability: availabilityFor(row.outcome),
          responseTimeMs: row.responseTimeMs,
          checkedAt: row.checkedAt,
          roundId: row.roundId,
          trigger: row.trigger,
        }
      : null;
  }

  async listForMonitor(
    organizationId: string,
    monitorId: string,
    query: CheckHistoryQuery,
  ): Promise<CheckHistoryPage> {
    await this.assertMonitorExists(organizationId, monitorId);
    const cursor = query.cursor ? decodeHistoryCursor(query.cursor) : undefined;
    const cursorDate = cursor ? new Date(cursor.createdAt) : undefined;

    const rows = await this.db
      .select(historySelection)
      .from(checkRounds)
      .innerJoin(
        checkExecutionAssignments,
        and(
          eq(checkExecutionAssignments.organizationId, checkRounds.organizationId),
          eq(checkExecutionAssignments.roundId, checkRounds.id),
          eq(checkExecutionAssignments.location, 'local'),
        ),
      )
      .leftJoin(
        checkExecutionResults,
        and(
          eq(checkExecutionResults.organizationId, checkRounds.organizationId),
          eq(checkExecutionResults.roundId, checkRounds.id),
          eq(checkExecutionResults.assignmentId, checkExecutionAssignments.id),
        ),
      )
      .where(
        and(
          eq(checkRounds.organizationId, organizationId),
          eq(checkRounds.monitorId, monitorId),
          query.trigger ? eq(checkRounds.trigger, query.trigger) : undefined,
          cursor && cursorDate
            ? or(
                lt(checkRounds.createdAt, cursorDate),
                and(eq(checkRounds.createdAt, cursorDate), lt(checkRounds.id, cursor.roundId)),
              )
            : undefined,
        ),
      )
      .orderBy(desc(checkRounds.createdAt), desc(checkRounds.id))
      .limit(query.limit + 1);

    const hasNextPage = rows.length > query.limit;
    const pageRows = hasNextPage ? rows.slice(0, query.limit) : rows;
    const items = pageRows.map(toListItem);
    const last = pageRows.at(-1);
    return {
      items,
      nextCursor:
        hasNextPage && last
          ? encodeHistoryCursor({
              contractVersion: 1,
              createdAt: last.createdAt.toISOString(),
              roundId: last.id,
            })
          : null,
    };
  }

  async findForMonitor(
    organizationId: string,
    monitorId: string,
    roundId: string,
  ): Promise<CheckHistoryDetail | null> {
    const [row] = await this.db
      .select(historySelection)
      .from(checkRounds)
      .innerJoin(
        checkExecutionAssignments,
        and(
          eq(checkExecutionAssignments.organizationId, checkRounds.organizationId),
          eq(checkExecutionAssignments.roundId, checkRounds.id),
          eq(checkExecutionAssignments.location, 'local'),
        ),
      )
      .leftJoin(
        checkExecutionResults,
        and(
          eq(checkExecutionResults.organizationId, checkRounds.organizationId),
          eq(checkExecutionResults.roundId, checkRounds.id),
          eq(checkExecutionResults.assignmentId, checkExecutionAssignments.id),
        ),
      )
      .where(
        and(
          eq(checkRounds.organizationId, organizationId),
          eq(checkRounds.monitorId, monitorId),
          eq(checkRounds.id, roundId),
        ),
      )
      .limit(1);

    if (!row) return null;
    const assertionEvaluation = row.resultId
      ? parseStoredAssertionEvaluation(row.assertionEvaluation)
      : null;
    return {
      id: row.id,
      monitorId: row.monitorId,
      trigger: row.trigger,
      status: row.status,
      assignmentStatus: row.assignmentStatus,
      createdAt: row.createdAt,
      result: row.resultId
        ? {
            outcome: required(row.outcome),
            stage: required(row.stage),
            reason: required(row.reason),
            statusCode: row.statusCode,
            responseTimeMs: row.responseTimeMs,
            attemptDurationMs: required(row.attemptDurationMs),
            redirects: parseHttpRedirectHops(row.redirects ?? []),
            assertionEvaluation: required(assertionEvaluation),
            checkedAt: required(row.checkedAt),
          }
        : null,
    };
  }

  private async assertMonitorExists(organizationId: string, monitorId: string): Promise<void> {
    const [monitor] = await this.db
      .select({ id: monitors.id })
      .from(monitors)
      .where(and(eq(monitors.organizationId, organizationId), eq(monitors.id, monitorId)))
      .limit(1);
    if (!monitor) throw new CheckHistoryMonitorNotFoundError();
  }
}

const historySelection = {
  id: checkRounds.id,
  monitorId: checkRounds.monitorId,
  trigger: checkRounds.trigger,
  status: checkRounds.status,
  assignmentStatus: checkExecutionAssignments.status,
  createdAt: checkRounds.createdAt,
  resultId: checkExecutionResults.id,
  outcome: checkExecutionResults.outcome,
  stage: checkExecutionResults.stage,
  reason: checkExecutionResults.reason,
  statusCode: checkExecutionResults.statusCode,
  responseTimeMs: checkExecutionResults.responseTimeMs,
  attemptDurationMs: checkExecutionResults.attemptDurationMs,
  redirects: checkExecutionResults.redirects,
  assertionEvaluation: checkExecutionResults.assertionEvaluation,
  checkedAt: checkExecutionResults.checkedAt,
};

function toListItem(row: HistoryRow): CheckHistoryListItem {
  const assertionEvaluation = row.resultId
    ? parseStoredAssertionEvaluation(row.assertionEvaluation)
    : null;
  return {
    id: row.id,
    monitorId: row.monitorId,
    trigger: row.trigger,
    status: row.status,
    assignmentStatus: row.assignmentStatus,
    createdAt: row.createdAt,
    result: row.resultId
      ? {
          outcome: required(row.outcome),
          stage: required(row.stage),
          reason: required(row.reason),
          statusCode: row.statusCode,
          responseTimeMs: row.responseTimeMs,
          attemptDurationMs: required(row.attemptDurationMs),
          assertionOutcome: required(assertionEvaluation).outcome,
          checkedAt: required(row.checkedAt),
        }
      : null,
  };
}

export class CheckHistoryMonitorNotFoundError extends Error {
  constructor() {
    super('Monitor not found.');
    this.name = 'CheckHistoryMonitorNotFoundError';
  }
}

export class CheckHistoryQueryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CheckHistoryQueryError';
  }
}

export function parseCheckHistoryQuery(value: Record<string, unknown>): CheckHistoryQuery {
  const keys = Object.keys(value);
  if (keys.some((key) => !['cursor', 'limit', 'trigger'].includes(key))) {
    throw new CheckHistoryQueryError('History query contains unsupported parameters.');
  }
  const rawLimit = value.limit;
  const limit = rawLimit === undefined ? 25 : Number(rawLimit);
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 100 ||
    (rawLimit !== undefined && (typeof rawLimit !== 'string' || String(limit) !== rawLimit))
  ) {
    throw new CheckHistoryQueryError('History limit must be an integer from 1 to 100.');
  }
  if (value.trigger !== undefined && value.trigger !== 'MANUAL' && value.trigger !== 'SCHEDULED') {
    throw new CheckHistoryQueryError('History trigger must be MANUAL or SCHEDULED.');
  }
  if (value.cursor !== undefined && typeof value.cursor !== 'string') {
    throw new CheckHistoryQueryError('History cursor is invalid.');
  }
  if (value.cursor) decodeHistoryCursor(value.cursor);
  return {
    limit,
    ...(typeof value.cursor === 'string' ? { cursor: value.cursor } : {}),
    ...(value.trigger === 'MANUAL' || value.trigger === 'SCHEDULED'
      ? { trigger: value.trigger }
      : {}),
  };
}

function encodeHistoryCursor(cursor: HistoryCursorV1): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

function decodeHistoryCursor(value: string): HistoryCursorV1 {
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
      keys[2] !== 'roundId' ||
      decoded.contractVersion !== 1 ||
      typeof decoded.createdAt !== 'string' ||
      new Date(decoded.createdAt).toISOString() !== decoded.createdAt ||
      typeof decoded.roundId !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
        decoded.roundId,
      )
    ) {
      throw new Error();
    }
    return decoded as unknown as HistoryCursorV1;
  } catch {
    throw new CheckHistoryQueryError('History cursor is invalid.');
  }
}

function availabilityFor(outcome: CheckExecutionResultRecord['outcome']): CurrentAvailability {
  if (outcome === 'PASS') return 'AVAILABLE';
  if (outcome === 'FAIL') return 'UNAVAILABLE';
  return 'UNKNOWN';
}

function required<T>(value: T | null): T {
  if (value === null) throw new Error('Completed check result is missing required data.');
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
