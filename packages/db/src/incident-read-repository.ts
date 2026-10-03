import { Buffer } from 'node:buffer';
import { and, asc, desc, eq, lt, or } from 'drizzle-orm';
import { INCIDENT_FAILURE_THRESHOLD } from '@watchrail/domain';
import type { WatchrailDatabase } from './client.js';
import { incidents, monitorIncidentState, monitors } from './schema.js';

export interface CurrentIncidentState {
  failureStreak: {
    count: number;
    threshold: typeof INCIDENT_FAILURE_THRESHOLD;
    startedAt: Date;
    startedByRoundId: string;
  } | null;
  currentIncident: {
    id: string;
    status: 'OPEN';
    startedAt: Date;
    openedAt: Date;
    startedByRoundId: string;
    openedByRoundId: string;
  } | null;
}

export interface IncidentHistoryItem {
  id: string;
  status: 'OPEN' | 'RESOLVED';
  startedAt: Date;
  openedAt: Date;
  resolvedAt: Date | null;
}

export interface IncidentDetail extends IncidentHistoryItem {
  monitorId: string;
  startedByRoundId: string;
  openedByRoundId: string;
  resolvedByRoundId: string | null;
  createdAt: Date;
}

export interface IncidentHistoryPage {
  items: IncidentHistoryItem[];
  nextCursor: string | null;
}

export interface IncidentHistoryQuery {
  limit: number;
  cursor?: string;
}

interface IncidentCursorV1 {
  contractVersion: 1;
  openedAt: string;
  incidentId: string;
}

export class IncidentReadRepository {
  constructor(private readonly db: WatchrailDatabase) {}

  async currentForOrganization(organizationId: string): Promise<Map<string, CurrentIncidentState>> {
    const rows = await this.db
      .select(currentSelection)
      .from(monitorIncidentState)
      .leftJoin(
        incidents,
        and(
          eq(incidents.organizationId, monitorIncidentState.organizationId),
          eq(incidents.monitorId, monitorIncidentState.monitorId),
          eq(incidents.status, 'OPEN'),
        ),
      )
      .where(eq(monitorIncidentState.organizationId, organizationId))
      .orderBy(asc(monitorIncidentState.monitorId));
    return new Map(rows.map((row) => [row.monitorId, toCurrentState(row)]));
  }

  async currentForMonitor(
    organizationId: string,
    monitorId: string,
  ): Promise<CurrentIncidentState> {
    await this.assertMonitorExists(organizationId, monitorId);
    const [row] = await this.db
      .select(currentSelection)
      .from(monitorIncidentState)
      .leftJoin(
        incidents,
        and(
          eq(incidents.organizationId, monitorIncidentState.organizationId),
          eq(incidents.monitorId, monitorIncidentState.monitorId),
          eq(incidents.status, 'OPEN'),
        ),
      )
      .where(
        and(
          eq(monitorIncidentState.organizationId, organizationId),
          eq(monitorIncidentState.monitorId, monitorId),
        ),
      )
      .limit(1);
    if (!row) throw new IncidentStateInvariantError();
    return toCurrentState(row);
  }

  async listForMonitor(
    organizationId: string,
    monitorId: string,
    query: IncidentHistoryQuery,
  ): Promise<IncidentHistoryPage> {
    await this.assertMonitorExists(organizationId, monitorId);
    const cursor = query.cursor ? decodeCursor(query.cursor) : undefined;
    const cursorDate = cursor ? new Date(cursor.openedAt) : undefined;
    const rows = await this.db
      .select(historySelection)
      .from(incidents)
      .where(
        and(
          eq(incidents.organizationId, organizationId),
          eq(incidents.monitorId, monitorId),
          cursor && cursorDate
            ? or(
                lt(incidents.openedAt, cursorDate),
                and(eq(incidents.openedAt, cursorDate), lt(incidents.id, cursor.incidentId)),
              )
            : undefined,
        ),
      )
      .orderBy(desc(incidents.openedAt), desc(incidents.id))
      .limit(query.limit + 1);
    const hasNext = rows.length > query.limit;
    const pageRows = hasNext ? rows.slice(0, query.limit) : rows;
    const last = pageRows.at(-1);
    return {
      items: pageRows,
      nextCursor:
        hasNext && last
          ? encodeCursor({
              contractVersion: 1,
              openedAt: last.openedAt.toISOString(),
              incidentId: last.id,
            })
          : null,
    };
  }

  async findForMonitor(
    organizationId: string,
    monitorId: string,
    incidentId: string,
  ): Promise<IncidentDetail | null> {
    const [incident] = await this.db
      .select()
      .from(incidents)
      .where(
        and(
          eq(incidents.organizationId, organizationId),
          eq(incidents.monitorId, monitorId),
          eq(incidents.id, incidentId),
        ),
      )
      .limit(1);
    return incident ?? null;
  }

  private async assertMonitorExists(organizationId: string, monitorId: string): Promise<void> {
    const [monitor] = await this.db
      .select({ id: monitors.id })
      .from(monitors)
      .where(and(eq(monitors.organizationId, organizationId), eq(monitors.id, monitorId)))
      .limit(1);
    if (!monitor) throw new IncidentMonitorNotFoundError();
  }
}

const currentSelection = {
  monitorId: monitorIncidentState.monitorId,
  consecutiveFailures: monitorIncidentState.consecutiveFailures,
  failureStreakStartedAt: monitorIncidentState.failureStreakStartedAt,
  failureStreakStartedRoundId: monitorIncidentState.failureStreakStartedRoundId,
  incidentId: incidents.id,
  incidentStartedAt: incidents.startedAt,
  incidentOpenedAt: incidents.openedAt,
  incidentStartedByRoundId: incidents.startedByRoundId,
  incidentOpenedByRoundId: incidents.openedByRoundId,
};

const historySelection = {
  id: incidents.id,
  status: incidents.status,
  startedAt: incidents.startedAt,
  openedAt: incidents.openedAt,
  resolvedAt: incidents.resolvedAt,
};

function toCurrentState(row: {
  consecutiveFailures: number;
  failureStreakStartedAt: Date | null;
  failureStreakStartedRoundId: string | null;
  incidentId: string | null;
  incidentStartedAt: Date | null;
  incidentOpenedAt: Date | null;
  incidentStartedByRoundId: string | null;
  incidentOpenedByRoundId: string | null;
}): CurrentIncidentState {
  return {
    failureStreak:
      row.consecutiveFailures === 0
        ? null
        : {
            count: row.consecutiveFailures,
            threshold: INCIDENT_FAILURE_THRESHOLD,
            startedAt: required(row.failureStreakStartedAt),
            startedByRoundId: required(row.failureStreakStartedRoundId),
          },
    currentIncident: row.incidentId
      ? {
          id: row.incidentId,
          status: 'OPEN',
          startedAt: required(row.incidentStartedAt),
          openedAt: required(row.incidentOpenedAt),
          startedByRoundId: required(row.incidentStartedByRoundId),
          openedByRoundId: required(row.incidentOpenedByRoundId),
        }
      : null,
  };
}

export class IncidentMonitorNotFoundError extends Error {
  constructor() {
    super('Monitor not found.');
    this.name = 'IncidentMonitorNotFoundError';
  }
}

export class IncidentStateInvariantError extends Error {
  constructor() {
    super('Monitor incident state is missing.');
    this.name = 'IncidentStateInvariantError';
  }
}

export class IncidentHistoryQueryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IncidentHistoryQueryError';
  }
}

export function parseIncidentHistoryQuery(value: Record<string, unknown>): IncidentHistoryQuery {
  if (Object.keys(value).some((key) => !['cursor', 'limit'].includes(key))) {
    throw new IncidentHistoryQueryError('Incident history query contains unsupported parameters.');
  }
  const rawLimit = value.limit;
  const limit = rawLimit === undefined ? 25 : Number(rawLimit);
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 100 ||
    (rawLimit !== undefined && (typeof rawLimit !== 'string' || String(limit) !== rawLimit))
  ) {
    throw new IncidentHistoryQueryError('Incident history limit must be an integer from 1 to 100.');
  }
  if (value.cursor !== undefined && typeof value.cursor !== 'string') {
    throw new IncidentHistoryQueryError('Incident history cursor is invalid.');
  }
  if (value.cursor) decodeCursor(value.cursor);
  return { limit, ...(typeof value.cursor === 'string' ? { cursor: value.cursor } : {}) };
}

function encodeCursor(cursor: IncidentCursorV1): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

function decodeCursor(value: string): IncidentCursorV1 {
  try {
    const bytes = Buffer.from(value, 'base64url');
    if (bytes.toString('base64url') !== value) throw new Error();
    const decoded: unknown = JSON.parse(bytes.toString('utf8'));
    if (!isRecord(decoded)) throw new Error();
    const keys = Object.keys(decoded).sort();
    if (
      keys.length !== 3 ||
      keys[0] !== 'contractVersion' ||
      keys[1] !== 'incidentId' ||
      keys[2] !== 'openedAt' ||
      decoded.contractVersion !== 1 ||
      typeof decoded.openedAt !== 'string' ||
      new Date(decoded.openedAt).toISOString() !== decoded.openedAt ||
      typeof decoded.incidentId !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
        decoded.incidentId,
      )
    ) {
      throw new Error();
    }
    return decoded as unknown as IncidentCursorV1;
  } catch {
    throw new IncidentHistoryQueryError('Incident history cursor is invalid.');
  }
}

function required<T>(value: T | null): T {
  if (value === null) throw new IncidentStateInvariantError();
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
