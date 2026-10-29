import { Buffer } from 'node:buffer';
import { and, asc, desc, eq, gte, inArray, lt, or, sql } from 'drizzle-orm';
import {
  parseHttpRedirectHops,
  parseStoredAssertionEvaluation,
  type AssertionEvaluationV1,
  type CheckRoundTrigger,
  type HttpRedirectHop,
  type AggregateRoundDecisionV1,
  type AggregateHealthState,
  type RegionalEvaluationV1,
} from '@watchrail/domain';
import type { WatchrailDatabase } from './client.js';
import {
  checkExecutionAssignments,
  checkExecutionResults,
  checkRegionalEvaluations,
  checkRegionalExecutions,
  checkRoundAggregates,
  checkRounds,
  monitors,
  type CheckExecutionAssignmentRecord,
  type CheckExecutionResultRecord,
  type CheckRoundRecord,
  type RegionalDiagnosticSummary,
} from './schema.js';

export type CurrentAvailability = 'AVAILABLE' | 'UNAVAILABLE' | 'UNKNOWN';

export interface CurrentCheck {
  kind: 'SINGLE_LOCATION' | 'MULTI_LOCATION';
  availability: CurrentAvailability;
  responseTimeMs: number | null;
  checkedAt: Date;
  roundId: string;
  trigger: CheckRoundTrigger;
  location: string | null;
  aggregateOutcome: AggregateHealthState | null;
  coverage: { numerator: number; denominator: number } | null;
  reachability: { numerator: number; denominator: number } | null;
}

export interface CheckHistoryListItem {
  id: string;
  monitorId: string;
  trigger: CheckRoundTrigger;
  status: CheckRoundRecord['status'];
  assignmentStatus: CheckExecutionAssignmentRecord['status'] | null;
  location: string | null;
  createdAt: Date;
  result:
    | {
        kind: 'SINGLE_LOCATION';
        outcome: CheckExecutionResultRecord['outcome'];
        stage: CheckExecutionResultRecord['stage'];
        reason: CheckExecutionResultRecord['reason'];
        statusCode: number | null;
        responseTimeMs: number | null;
        attemptDurationMs: number;
        assertionOutcome: AssertionEvaluationV1['outcome'];
        checkedAt: Date;
      }
    | {
        kind: 'MULTI_LOCATION';
        outcome: AggregateHealthState;
        counts: AggregateRoundDecisionV1['counts'];
        coverage: AggregateRoundDecisionV1['coverage'];
        reachability: AggregateRoundDecisionV1['reachability'];
        finalizedAt: Date;
      }
    | null;
}

export interface CheckHistoryDetail extends Omit<CheckHistoryListItem, 'result'> {
  result:
    | {
        kind: 'SINGLE_LOCATION';
        outcome: CheckExecutionResultRecord['outcome'];
        stage: CheckExecutionResultRecord['stage'];
        reason: CheckExecutionResultRecord['reason'];
        statusCode: number | null;
        responseTimeMs: number | null;
        attemptDurationMs: number;
        redirects: HttpRedirectHop[];
        assertionEvaluation: AssertionEvaluationV1;
        checkedAt: Date;
      }
    | {
        kind: 'MULTI_LOCATION';
        outcome: AggregateHealthState;
        counts: AggregateRoundDecisionV1['counts'];
        coverage: AggregateRoundDecisionV1['coverage'];
        reachability: AggregateRoundDecisionV1['reachability'];
        finalizedAt: Date;
        regions: RegionalHistoryDetail[];
      }
    | null;
}

export interface RegionalHistoryDetail {
  location: string;
  phase: RegionalEvaluationV1['phase'];
  outcome: 'PASS' | 'CONFIRMED_FAIL' | 'UNKNOWN' | null;
  terminalReason: string | null;
  executions: Array<{
    id: string;
    role: 'PRIMARY' | 'CONFIRMATION';
    agentId: string;
    observation: unknown;
    diagnosticSummary: RegionalDiagnosticSummary | null;
    acceptedAt: Date;
  }>;
}

export interface CheckHistoryPage {
  items: CheckHistoryListItem[];
  nextCursor: string | null;
}

export type AvailabilityHistoryRange = '24h' | '7d' | '30d' | '90d';
export type AvailabilityHistoryStatus = 'UP' | 'DOWN' | 'DEGRADED' | 'UNKNOWN' | 'NO_DATA';

export interface AvailabilityHistory {
  range: {
    key: AvailabilityHistoryRange;
    start: Date;
    end: Date;
    bucketSeconds: number;
  };
  buckets: Array<{
    start: Date;
    end: Date;
    status: AvailabilityHistoryStatus;
    checks: number;
    up: number;
    down: number;
    degraded: number;
    unknown: number;
  }>;
}

export interface ResponseTimeOverview {
  range: { start: Date; end: Date };
  series: Array<{
    monitorId: string;
    monitorName: string;
    points: Array<{
      date: string;
      averageResponseTimeMs: number;
      sampleCount: number;
    }>;
  }>;
}

interface ResponseTimeOverviewRow extends Record<string, unknown> {
  monitorId: string;
  monitorName: string;
  date: string;
  averageResponseTimeMs: string | number;
  sampleCount: string | number;
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
  location: string;
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

  async responseTimeOverview(
    organizationId: string,
    now = new Date(),
  ): Promise<ResponseTimeOverview> {
    const end = new Date(now);
    const start = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate() - 6));
    const result = await this.db.execute<ResponseTimeOverviewRow>(sql`
      with observations as (
        select
          ${checkRounds.monitorId} as monitor_id,
          ${monitors.name} as monitor_name,
          ${checkExecutionResults.checkedAt} as observed_at,
          ${checkExecutionResults.responseTimeMs} as response_time_ms
        from ${checkRounds}
        inner join ${monitors}
          on ${monitors.organizationId} = ${checkRounds.organizationId}
         and ${monitors.id} = ${checkRounds.monitorId}
        inner join ${checkExecutionAssignments}
          on ${checkExecutionAssignments.organizationId} = ${checkRounds.organizationId}
         and ${checkExecutionAssignments.roundId} = ${checkRounds.id}
        inner join ${checkExecutionResults}
          on ${checkExecutionResults.organizationId} = ${checkRounds.organizationId}
         and ${checkExecutionResults.roundId} = ${checkRounds.id}
         and ${checkExecutionResults.assignmentId} = ${checkExecutionAssignments.id}
        where ${checkRounds.organizationId} = ${organizationId}
          and ${monitors.lifecycleState} = 'ENABLED'
          and ${checkRounds.trigger} = 'SCHEDULED'
          and ${checkRounds.status} = 'COMPLETED'
          and ${checkExecutionResults.checkedAt} >= ${start}
          and ${checkExecutionResults.checkedAt} <= ${end}
          and ${checkExecutionResults.responseTimeMs} is not null
          and not exists (
            select 1
            from ${checkRoundAggregates}
            where ${checkRoundAggregates.organizationId} = ${checkRounds.organizationId}
              and ${checkRoundAggregates.roundId} = ${checkRounds.id}
          )

        union all

        select
          ${checkRounds.monitorId} as monitor_id,
          ${monitors.name} as monitor_name,
          ${checkRegionalExecutions.acceptedAt} as observed_at,
          (${checkRegionalExecutions.diagnosticSummary} ->> 'responseTimeMs')::double precision
            as response_time_ms
        from ${checkRounds}
        inner join ${monitors}
          on ${monitors.organizationId} = ${checkRounds.organizationId}
         and ${monitors.id} = ${checkRounds.monitorId}
        inner join ${checkRoundAggregates}
          on ${checkRoundAggregates.organizationId} = ${checkRounds.organizationId}
         and ${checkRoundAggregates.roundId} = ${checkRounds.id}
        inner join ${checkRegionalExecutions}
          on ${checkRegionalExecutions.organizationId} = ${checkRounds.organizationId}
         and ${checkRegionalExecutions.roundId} = ${checkRounds.id}
        where ${checkRounds.organizationId} = ${organizationId}
          and ${monitors.lifecycleState} = 'ENABLED'
          and ${checkRounds.trigger} = 'SCHEDULED'
          and ${checkRounds.status} = 'COMPLETED'
          and ${checkRegionalExecutions.role} = 'PRIMARY'
          and ${checkRegionalExecutions.acceptedAt} >= ${start}
          and ${checkRegionalExecutions.acceptedAt} <= ${end}
          and jsonb_typeof(${checkRegionalExecutions.diagnosticSummary} -> 'responseTimeMs') = 'number'
      ), selected_monitors as (
        select monitor_id, monitor_name
        from observations
        group by monitor_id, monitor_name
        order by count(*) desc, monitor_name asc, monitor_id asc
        limit 4
      )
      select
        observations.monitor_id as "monitorId",
        observations.monitor_name as "monitorName",
        to_char(
          date_trunc('day', observations.observed_at at time zone 'UTC'),
          'YYYY-MM-DD'
        ) as date,
        avg(observations.response_time_ms) as "averageResponseTimeMs",
        count(*) as "sampleCount"
      from observations
      inner join selected_monitors using (monitor_id, monitor_name)
      group by observations.monitor_id, observations.monitor_name, date
      order by observations.monitor_name asc, observations.monitor_id asc, date asc
    `);

    const series = new Map<string, ResponseTimeOverview['series'][number]>();
    for (const row of result.rows) {
      const item = series.get(row.monitorId) ?? {
        monitorId: row.monitorId,
        monitorName: row.monitorName,
        points: [],
      };
      item.points.push({
        date: row.date,
        averageResponseTimeMs: Number(row.averageResponseTimeMs),
        sampleCount: Number(row.sampleCount),
      });
      series.set(row.monitorId, item);
    }
    return { range: { start, end }, series: [...series.values()] };
  }

  async currentForOrganization(organizationId: string): Promise<Map<string, CurrentCheck>> {
    const rows = await this.db
      .selectDistinctOn([checkRounds.monitorId], {
        monitorId: checkRounds.monitorId,
        roundId: checkRounds.id,
        trigger: checkRounds.trigger,
        outcome: checkExecutionResults.outcome,
        responseTimeMs: checkExecutionResults.responseTimeMs,
        checkedAt: checkExecutionResults.checkedAt,
        location: checkExecutionAssignments.location,
        createdAt: checkRounds.createdAt,
      })
      .from(checkRounds)
      .innerJoin(
        checkExecutionAssignments,
        and(
          eq(checkExecutionAssignments.organizationId, checkRounds.organizationId),
          eq(checkExecutionAssignments.roundId, checkRounds.id),
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
        and(
          eq(checkRounds.organizationId, organizationId),
          sql`not exists (
            select 1 from ${checkRoundAggregates}
            where ${checkRoundAggregates.organizationId} = ${checkRounds.organizationId}
              and ${checkRoundAggregates.roundId} = ${checkRounds.id}
          )`,
        ),
      )
      .orderBy(asc(checkRounds.monitorId), desc(checkRounds.createdAt), desc(checkRounds.id));

    const projections = new Map<string, CurrentCheck>();
    const newestRound = new Map<string, { createdAt: Date; roundId: string }>();
    for (const row of rows) {
      projections.set(row.monitorId, {
        kind: 'SINGLE_LOCATION',
        availability: availabilityFor(row.outcome),
        responseTimeMs: row.responseTimeMs,
        checkedAt: row.checkedAt,
        roundId: row.roundId,
        trigger: row.trigger,
        location: row.location,
        aggregateOutcome: null,
        coverage: null,
        reachability: null,
      });
      newestRound.set(row.monitorId, { createdAt: row.createdAt, roundId: row.roundId });
    }
    const aggregates = await this.db
      .selectDistinctOn([checkRounds.monitorId], {
        monitorId: checkRounds.monitorId,
        roundId: checkRounds.id,
        trigger: checkRounds.trigger,
        createdAt: checkRounds.createdAt,
        finalizedAt: checkRoundAggregates.finalizedAt,
        outcome: checkRoundAggregates.outcome,
        aggregate: checkRoundAggregates.aggregate,
      })
      .from(checkRoundAggregates)
      .innerJoin(
        checkRounds,
        and(
          eq(checkRounds.organizationId, checkRoundAggregates.organizationId),
          eq(checkRounds.id, checkRoundAggregates.roundId),
        ),
      )
      .where(eq(checkRoundAggregates.organizationId, organizationId))
      .orderBy(asc(checkRounds.monitorId), desc(checkRounds.createdAt), desc(checkRounds.id));
    for (const row of aggregates) {
      const newest = newestRound.get(row.monitorId);
      if (newest && compareRoundOrder(newest, row) >= 0) continue;
      projections.set(row.monitorId, {
        kind: 'MULTI_LOCATION',
        availability: aggregateAvailabilityFor(row.outcome as AggregateHealthState),
        responseTimeMs: null,
        checkedAt: row.finalizedAt,
        roundId: row.roundId,
        trigger: row.trigger,
        location: null,
        aggregateOutcome: row.outcome as AggregateHealthState,
        coverage: row.aggregate.coverage,
        reachability: row.aggregate.reachability,
      });
      newestRound.set(row.monitorId, { createdAt: row.createdAt, roundId: row.roundId });
    }
    return projections;
  }

  async currentForMonitor(organizationId: string, monitorId: string): Promise<CurrentCheck | null> {
    return (await this.currentForOrganization(organizationId)).get(monitorId) ?? null;
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
      .select({
        id: checkRounds.id,
        monitorId: checkRounds.monitorId,
        trigger: checkRounds.trigger,
        status: checkRounds.status,
        createdAt: checkRounds.createdAt,
      })
      .from(checkRounds)
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
    const roundIds = pageRows.map(({ id }) => id);
    const [singleRows, aggregateRows] =
      roundIds.length === 0
        ? [[], []]
        : await Promise.all([
            this.db
              .select(historySelection)
              .from(checkRounds)
              .innerJoin(
                checkExecutionAssignments,
                and(
                  eq(checkExecutionAssignments.organizationId, checkRounds.organizationId),
                  eq(checkExecutionAssignments.roundId, checkRounds.id),
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
              .where(inArray(checkRounds.id, roundIds))
              .orderBy(asc(checkExecutionAssignments.location)),
            this.db
              .select()
              .from(checkRoundAggregates)
              .where(
                and(
                  eq(checkRoundAggregates.organizationId, organizationId),
                  inArray(checkRoundAggregates.roundId, roundIds),
                ),
              ),
          ]);
    const singleByRound = new Map<string, HistoryRow>();
    for (const row of singleRows) if (!singleByRound.has(row.id)) singleByRound.set(row.id, row);
    const aggregateByRound = new Map(aggregateRows.map((row) => [row.roundId, row]));
    const items = pageRows.map((round) => {
      const aggregate = aggregateByRound.get(round.id);
      if (aggregate) {
        return {
          ...round,
          assignmentStatus: 'COMPLETED' as const,
          location: null,
          result: {
            kind: 'MULTI_LOCATION' as const,
            outcome: aggregate.outcome as AggregateHealthState,
            counts: aggregate.aggregate.counts,
            coverage: aggregate.aggregate.coverage,
            reachability: aggregate.aggregate.reachability,
            finalizedAt: aggregate.finalizedAt,
          },
        };
      }
      const single = singleByRound.get(round.id);
      if (!single) {
        return { ...round, assignmentStatus: null, location: null, result: null };
      }
      return toListItem(single);
    });
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

  async availabilityForMonitor(
    organizationId: string,
    monitorId: string,
    range: AvailabilityHistoryRange,
  ): Promise<AvailabilityHistory> {
    await this.assertMonitorExists(organizationId, monitorId);
    const end = new Date();
    const start = new Date(end.getTime() - availabilityRangeMilliseconds(range));
    const bucketCount = 48;
    const bucketMilliseconds = (end.getTime() - start.getTime()) / bucketCount;

    const rows = await this.db
      .selectDistinctOn([checkRounds.id], {
        id: checkRounds.id,
        createdAt: checkRounds.createdAt,
        singleOutcome: checkExecutionResults.outcome,
        aggregateOutcome: checkRoundAggregates.outcome,
      })
      .from(checkRounds)
      .leftJoin(
        checkExecutionAssignments,
        and(
          eq(checkExecutionAssignments.organizationId, checkRounds.organizationId),
          eq(checkExecutionAssignments.roundId, checkRounds.id),
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
      .leftJoin(
        checkRoundAggregates,
        and(
          eq(checkRoundAggregates.organizationId, checkRounds.organizationId),
          eq(checkRoundAggregates.roundId, checkRounds.id),
        ),
      )
      .where(
        and(
          eq(checkRounds.organizationId, organizationId),
          eq(checkRounds.monitorId, monitorId),
          gte(checkRounds.createdAt, start),
        ),
      )
      .orderBy(checkRounds.id, asc(checkExecutionAssignments.location));

    const counts = Array.from({ length: bucketCount }, () => ({
      up: 0,
      down: 0,
      degraded: 0,
      unknown: 0,
    }));
    for (const row of rows) {
      const index = Math.min(
        bucketCount - 1,
        Math.max(0, Math.floor((row.createdAt.getTime() - start.getTime()) / bucketMilliseconds)),
      );
      const outcome = availabilityOutcome(row.aggregateOutcome, row.singleOutcome);
      counts[index]![outcome] += 1;
    }

    return {
      range: {
        key: range,
        start,
        end,
        bucketSeconds: Math.round(bucketMilliseconds / 1000),
      },
      buckets: counts.map((bucket, index) => ({
        start: new Date(start.getTime() + index * bucketMilliseconds),
        end: new Date(start.getTime() + (index + 1) * bucketMilliseconds),
        status: availabilityBucketStatus(bucket),
        checks: bucket.up + bucket.down + bucket.degraded + bucket.unknown,
        ...bucket,
      })),
    };
  }

  async findForMonitor(
    organizationId: string,
    monitorId: string,
    roundId: string,
  ): Promise<CheckHistoryDetail | null> {
    const [round] = await this.db
      .select()
      .from(checkRounds)
      .where(
        and(
          eq(checkRounds.organizationId, organizationId),
          eq(checkRounds.monitorId, monitorId),
          eq(checkRounds.id, roundId),
        ),
      )
      .limit(1);

    if (!round) return null;
    const [aggregate] = await this.db
      .select()
      .from(checkRoundAggregates)
      .where(
        and(
          eq(checkRoundAggregates.organizationId, organizationId),
          eq(checkRoundAggregates.roundId, roundId),
        ),
      )
      .limit(1);
    if (aggregate) {
      const [evaluations, executions] = await Promise.all([
        this.db
          .select()
          .from(checkRegionalEvaluations)
          .where(
            and(
              eq(checkRegionalEvaluations.organizationId, organizationId),
              eq(checkRegionalEvaluations.roundId, roundId),
            ),
          )
          .orderBy(asc(checkRegionalEvaluations.location)),
        this.db
          .select()
          .from(checkRegionalExecutions)
          .where(
            and(
              eq(checkRegionalExecutions.organizationId, organizationId),
              eq(checkRegionalExecutions.roundId, roundId),
            ),
          )
          .orderBy(asc(checkRegionalExecutions.location), asc(checkRegionalExecutions.acceptedAt)),
      ]);
      return {
        id: round.id,
        monitorId: round.monitorId,
        trigger: round.trigger,
        status: round.status,
        assignmentStatus: 'COMPLETED',
        location: null,
        createdAt: round.createdAt,
        result: {
          kind: 'MULTI_LOCATION',
          outcome: aggregate.outcome as AggregateHealthState,
          counts: aggregate.aggregate.counts,
          coverage: aggregate.aggregate.coverage,
          reachability: aggregate.aggregate.reachability,
          finalizedAt: aggregate.finalizedAt,
          regions: evaluations.map((evaluation) => ({
            location: evaluation.location,
            phase: evaluation.phase as RegionalEvaluationV1['phase'],
            outcome: evaluation.outcome as RegionalHistoryDetail['outcome'],
            terminalReason: evaluation.terminalReason,
            executions: executions
              .filter((execution) => execution.location === evaluation.location)
              .map((execution) => ({
                id: execution.id,
                role: execution.role as 'PRIMARY' | 'CONFIRMATION',
                agentId: execution.agentId,
                observation: execution.observation,
                diagnosticSummary: parseRegionalDiagnosticSummary(execution.diagnosticSummary),
                acceptedAt: execution.acceptedAt,
              })),
          })),
        },
      };
    }
    const [row] = await this.db
      .select(historySelection)
      .from(checkRounds)
      .innerJoin(
        checkExecutionAssignments,
        and(
          eq(checkExecutionAssignments.organizationId, checkRounds.organizationId),
          eq(checkExecutionAssignments.roundId, checkRounds.id),
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
      location: row.location,
      createdAt: row.createdAt,
      result: row.resultId
        ? {
            kind: 'SINGLE_LOCATION',
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

function compareRoundOrder(
  left: { createdAt: Date; roundId: string },
  right: { createdAt: Date; roundId: string },
): number {
  const timeDifference = left.createdAt.getTime() - right.createdAt.getTime();
  return timeDifference === 0 ? left.roundId.localeCompare(right.roundId) : timeDifference;
}

const historySelection = {
  id: checkRounds.id,
  monitorId: checkRounds.monitorId,
  trigger: checkRounds.trigger,
  status: checkRounds.status,
  assignmentStatus: checkExecutionAssignments.status,
  location: checkExecutionAssignments.location,
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
    location: row.location,
    createdAt: row.createdAt,
    result: row.resultId
      ? {
          kind: 'SINGLE_LOCATION',
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

export class AvailabilityHistoryQueryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AvailabilityHistoryQueryError';
  }
}

export function parseAvailabilityHistoryQuery(
  value: Record<string, unknown>,
): AvailabilityHistoryRange {
  const keys = Object.keys(value);
  if (keys.some((key) => key !== 'range')) {
    throw new AvailabilityHistoryQueryError(
      'Availability history query contains unsupported parameters.',
    );
  }
  const range = value.range ?? '7d';
  if (range !== '24h' && range !== '7d' && range !== '30d' && range !== '90d') {
    throw new AvailabilityHistoryQueryError(
      'Availability history range must be 24h, 7d, 30d, or 90d.',
    );
  }
  return range;
}

function availabilityRangeMilliseconds(range: AvailabilityHistoryRange): number {
  const day = 24 * 60 * 60 * 1000;
  if (range === '24h') return day;
  if (range === '7d') return 7 * day;
  if (range === '30d') return 30 * day;
  return 90 * day;
}

function availabilityOutcome(
  aggregate: string | null,
  single: CheckExecutionResultRecord['outcome'] | null,
): 'up' | 'down' | 'degraded' | 'unknown' {
  if (aggregate === 'UP') return 'up';
  if (aggregate === 'DOWN') return 'down';
  if (aggregate === 'DEGRADED') return 'degraded';
  if (aggregate === 'UNKNOWN') return 'unknown';
  if (single === 'PASS') return 'up';
  if (single === 'FAIL') return 'down';
  return 'unknown';
}

function availabilityBucketStatus(bucket: {
  up: number;
  down: number;
  degraded: number;
  unknown: number;
}): AvailabilityHistoryStatus {
  const checks = bucket.up + bucket.down + bucket.degraded + bucket.unknown;
  if (checks === 0) return 'NO_DATA';
  if (bucket.down > 0 && bucket.up === 0 && bucket.degraded === 0 && bucket.unknown === 0) {
    return 'DOWN';
  }
  if (bucket.degraded > 0 || (bucket.down > 0 && bucket.up > 0)) return 'DEGRADED';
  if (bucket.unknown > 0) return 'UNKNOWN';
  return 'UP';
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

function aggregateAvailabilityFor(outcome: AggregateHealthState): CurrentAvailability {
  if (outcome === 'UP') return 'AVAILABLE';
  if (outcome === 'UNKNOWN') return 'UNKNOWN';
  return 'UNAVAILABLE';
}

function parseRegionalDiagnosticSummary(value: unknown): RegionalDiagnosticSummary | null {
  if (value === null) return null;
  if (!isRecord(value)) throw new Error('Stored regional diagnostic summary is invalid.');
  const keys = Object.keys(value).sort();
  const expected = [
    'attemptDurationMs',
    'checkedAt',
    'reason',
    'responseTimeMs',
    'stage',
    'statusCode',
  ];
  const validStage = ['DNS', 'CONNECT', 'TLS', 'HTTP', 'PROBE'].includes(String(value.stage));
  const validTime = (candidate: unknown) =>
    candidate === null ||
    (typeof candidate === 'number' && Number.isFinite(candidate) && candidate >= 0);
  if (
    keys.length !== expected.length ||
    keys.some((key, index) => key !== expected[index]) ||
    !validStage ||
    typeof value.reason !== 'string' ||
    value.reason.length < 1 ||
    value.reason.length > 120 ||
    (value.statusCode !== null &&
      (!Number.isSafeInteger(value.statusCode) ||
        Number(value.statusCode) < 100 ||
        Number(value.statusCode) > 599)) ||
    !validTime(value.responseTimeMs) ||
    !validTime(value.attemptDurationMs) ||
    typeof value.attemptDurationMs !== 'number' ||
    typeof value.checkedAt !== 'string' ||
    Number.isNaN(Date.parse(value.checkedAt)) ||
    new Date(value.checkedAt).toISOString() !== value.checkedAt
  ) {
    throw new Error('Stored regional diagnostic summary is invalid.');
  }
  return value as unknown as RegionalDiagnosticSummary;
}

function required<T>(value: T | null): T {
  if (value === null) throw new Error('Completed check result is missing required data.');
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
