import Link from 'next/link';
import type { ReactNode } from 'react';
import { monitorCondition, summarizeMonitors } from '../../lib/monitor-summary';
import { formatPercent } from '../monitors/formatting';
import { MonitorTable } from '../monitors/monitor-table';
import type { Monitor, ResponseTimeOverview } from '../monitors/types';

const chartTones = [
  { stroke: 'stroke-rail-chart-1', fill: 'bg-rail-chart-1' },
  { stroke: 'stroke-rail-chart-2', fill: 'bg-rail-chart-2' },
  { stroke: 'stroke-rail-chart-3', fill: 'bg-rail-chart-3' },
  { stroke: 'stroke-rail-chart-4', fill: 'bg-rail-chart-4' },
] as const;

function average(values: Array<number | null | undefined>): number | null {
  const available = values.filter((value): value is number => value != null);
  if (available.length === 0) return null;
  return available.reduce((total, value) => total + value, 0) / available.length;
}

export function OverviewDashboard({
  monitors,
  responseTimes,
  responseTimesLoading,
  responseTimesError,
  onRetryResponseTimes,
  onDeleteMonitor,
}: {
  monitors: Monitor[];
  responseTimes: ResponseTimeOverview | undefined;
  responseTimesLoading: boolean;
  responseTimesError: string | undefined;
  onRetryResponseTimes: () => void;
  onDeleteMonitor?: ((monitor: Monitor) => void | Promise<void>) | undefined;
}) {
  const summary = summarizeMonitors(monitors);
  const averageUptime = average(monitors.map((monitor) => monitor.uptime?.uptimePercent));
  const averageCoverage = average(monitors.map((monitor) => monitor.uptime?.coveragePercent));
  return (
    <div className="mt-6 grid gap-6">
      <section aria-labelledby="overview-metrics-heading">
        <div className="mb-3 flex items-center justify-between gap-3">
          <h2 id="overview-metrics-heading" className="m-0 text-sm font-medium text-rail-text">
            Workspace health
          </h2>
          <span className="text-xs text-rail-muted">Latest authoritative state</span>
        </div>
        <dl className="grid gap-px overflow-hidden rounded-rail-panel border border-rail-border bg-rail-border sm:grid-cols-2 xl:grid-cols-4">
          <OverviewMetric
            label="Total monitors"
            value={summary.total.toString()}
            detail={`${summary.paused} paused`}
          />
          <OverviewMetric
            label="Operational"
            value={summary.operational.toString()}
            detail={`${summary.needsAttention} need attention`}
            tone="success"
          />
          <OverviewMetric
            label="Open incidents"
            value={summary.openIncidents.toString()}
            detail={summary.openIncidents === 0 ? 'No active incidents' : 'Action required'}
            tone={summary.openIncidents > 0 ? 'danger' : 'neutral'}
          />
          <OverviewMetric
            label="Average 7-day uptime"
            value={formatPercent(averageUptime)}
            detail={`Coverage ${formatPercent(averageCoverage)}`}
            title="Mean across monitors with seven-day availability evidence."
          />
        </dl>
      </section>

      <div className="grid items-stretch gap-4 xl:grid-cols-4">
        <section
          className="overflow-hidden rounded-rail-panel border border-rail-border bg-rail-header xl:col-span-3"
          aria-labelledby="response-times-heading"
        >
          <div className="flex flex-wrap items-start justify-between gap-3 border-b border-rail-border px-4 py-3">
            <div>
              <h2 id="response-times-heading" className="m-0 text-sm font-medium text-rail-text">
                Response time trends
              </h2>
              <p className="mt-1 mb-0 text-xs text-rail-muted">
                Daily averages from completed scheduled checks over the last seven UTC days
              </p>
            </div>
            <span className="text-[11px] text-rail-muted">Milliseconds</span>
          </div>
          <ResponseTimeChart
            data={responseTimes}
            loading={responseTimesLoading}
            error={responseTimesError}
            onRetry={onRetryResponseTimes}
          />
        </section>

        <LatestResponseComparison
          data={responseTimes}
          loading={responseTimesLoading}
          error={responseTimesError}
        />
      </div>

      <MonitorSnapshot monitors={monitors} onDeleteMonitor={onDeleteMonitor} />
    </div>
  );
}

function ResponseTimeChart({
  data,
  loading,
  error,
  onRetry,
}: {
  data: ResponseTimeOverview | undefined;
  loading: boolean;
  error: string | undefined;
  onRetry: () => void;
}) {
  if (loading && !data) {
    return (
      <div className="grid min-h-72 place-items-center px-4 py-8" role="status">
        <span className="text-sm text-rail-muted">Loading response-time history…</span>
      </div>
    );
  }
  if (error && !data) {
    return (
      <div
        className="flex min-h-72 flex-col items-start justify-center gap-3 px-4 py-8"
        role="alert"
      >
        <p className="m-0 text-sm text-rail-muted">{error}</p>
        <button
          type="button"
          className="min-h-9 rounded-rail-control border border-rail-border px-3 text-sm font-medium text-rail-text hover:bg-rail-hover"
          onClick={onRetry}
        >
          Retry
        </button>
      </div>
    );
  }
  if (!data || data.series.length === 0) {
    return (
      <div className="px-4 py-3">
        <EmptyInsight>No scheduled response-time evidence has been recorded yet.</EmptyInsight>
      </div>
    );
  }

  const dates = utcDates(data.range.start, 7);
  const values = data.series.flatMap((series) =>
    series.points.map((point) => point.averageResponseTimeMs),
  );
  const tickStep = Math.max(50, Math.ceil(Math.max(...values) / 4 / 50) * 50);
  const yMax = tickStep * 4;
  const plot = { left: 58, top: 20, width: 722, height: 202 };
  const xFor = (index: number) => plot.left + (index / Math.max(dates.length - 1, 1)) * plot.width;
  const yFor = (value: number) => plot.top + plot.height - (value / yMax) * plot.height;
  const yTicks = [1, 0.75, 0.5, 0.25, 0];

  return (
    <figure className="m-0 px-3 pt-4 pb-3 sm:px-4">
      <div className="overflow-x-auto">
        <svg
          className="block h-auto min-w-[760px]"
          viewBox="0 0 800 270"
          role="img"
          aria-labelledby="response-chart-title response-chart-description"
        >
          <title id="response-chart-title">Seven-day response-time trends</title>
          <desc id="response-chart-description">
            Daily average response time in milliseconds for up to four monitors. Missing days are
            shown as gaps.
          </desc>
          {yTicks.map((ratio) => {
            const y = plot.top + plot.height * (1 - ratio);
            return (
              <g key={ratio}>
                <line
                  x1={plot.left}
                  x2={plot.left + plot.width}
                  y1={y}
                  y2={y}
                  className="stroke-rail-border"
                  strokeWidth="1"
                />
                <text
                  x={plot.left - 10}
                  y={y + 4}
                  textAnchor="end"
                  className="fill-rail-muted text-[8px] tabular-nums"
                >
                  {Math.round(yMax * ratio)} ms
                </text>
              </g>
            );
          })}
          {dates.map((date, index) => (
            <text
              key={date}
              x={xFor(index)}
              y="250"
              textAnchor="middle"
              className="fill-rail-muted text-[8px]"
            >
              {formatChartDate(date)}
            </text>
          ))}
          {data.series.map((series, seriesIndex) => {
            const pointsByDate = new Map(series.points.map((point) => [point.date, point]));
            const segments = contiguousSegments(dates, pointsByDate, xFor, yFor);
            return segments.map((segment, segmentIndex) => (
              <g key={`${series.monitorId}-${segmentIndex}`}>
                <path
                  d={smoothPath(segment)}
                  fill="none"
                  className={chartTones[seriesIndex]!.stroke}
                  strokeWidth="2.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
                {segment.map((point) => (
                  <circle
                    key={`${point.x}-${point.y}`}
                    cx={point.x}
                    cy={point.y}
                    r="3"
                    className={`${chartTones[seriesIndex]!.fill} stroke-rail-header`}
                    strokeWidth="2"
                  >
                    <title>{`${series.monitorName} · ${point.date}: ${Math.round(point.value)} ms (${point.sampleCount} samples)`}</title>
                  </circle>
                ))}
              </g>
            ));
          })}
        </svg>
      </div>
      <figcaption className="mt-2 flex flex-wrap gap-x-5 gap-y-2 border-t border-rail-border pt-3">
        {data.series.map((series, index) => (
          <Link
            key={series.monitorId}
            href={`/monitors/${series.monitorId}`}
            className="inline-flex items-center gap-2 text-xs text-rail-subtle no-underline hover:text-rail-text hover:underline"
          >
            <span className={`size-2 rounded-full ${chartTones[index]!.fill}`} aria-hidden="true" />
            {series.monitorName}
          </Link>
        ))}
        <span className="ml-auto text-xs text-rail-muted">Daily average · UTC</span>
      </figcaption>
      <table className="sr-only">
        <caption>Response-time chart data in milliseconds</caption>
        <thead>
          <tr>
            <th scope="col">Monitor</th>
            <th scope="col">Date</th>
            <th scope="col">Average response time</th>
            <th scope="col">Samples</th>
          </tr>
        </thead>
        <tbody>
          {data.series.flatMap((series) =>
            series.points.map((point) => (
              <tr key={`${series.monitorId}-${point.date}`}>
                <th scope="row">{series.monitorName}</th>
                <td>{point.date}</td>
                <td>{Math.round(point.averageResponseTimeMs)} ms</td>
                <td>{point.sampleCount}</td>
              </tr>
            )),
          )}
        </tbody>
      </table>
    </figure>
  );
}

function LatestResponseComparison({
  data,
  loading,
  error,
}: {
  data: ResponseTimeOverview | undefined;
  loading: boolean;
  error: string | undefined;
}) {
  const latest = (data?.series ?? [])
    .map((series, index) => {
      const point = series.points.at(-1);
      return point ? { ...series, point, tone: chartTones[index]! } : null;
    })
    .filter((series): series is NonNullable<typeof series> => series != null)
    .sort((left, right) => right.point.averageResponseTimeMs - left.point.averageResponseTimeMs);
  const maximum = Math.max(...latest.map((series) => series.point.averageResponseTimeMs), 1);

  return (
    <section
      className="overflow-hidden rounded-rail-panel border border-rail-border bg-rail-header"
      aria-labelledby="latest-response-heading"
    >
      <div className="border-b border-rail-border px-4 py-3">
        <h2 id="latest-response-heading" className="m-0 text-sm font-medium text-rail-text">
          Latest daily average
        </h2>
        <p className="mt-1 mb-0 text-xs text-rail-muted">Most recent UTC day per monitor</p>
      </div>
      {loading && !data ? (
        <p className="m-0 px-4 py-5 text-xs text-rail-muted" role="status">
          Loading comparison…
        </p>
      ) : error && !data ? (
        <p className="m-0 px-4 py-5 text-xs text-rail-muted">Comparison unavailable.</p>
      ) : latest.length === 0 ? (
        <p className="m-0 px-4 py-5 text-xs text-rail-muted">No comparison available yet.</p>
      ) : (
        <ol className="m-0 grid list-none gap-5 px-4 py-5">
          {latest.map((series) => {
            const width = `${Math.max((series.point.averageResponseTimeMs / maximum) * 100, 4)}%`;
            return (
              <li key={series.monitorId}>
                <div className="mb-2 flex items-baseline justify-between gap-3">
                  <Link
                    href={`/monitors/${series.monitorId}`}
                    className="min-w-0 truncate text-xs font-medium text-rail-text no-underline hover:underline"
                  >
                    {series.monitorName}
                  </Link>
                  <span className="shrink-0 text-xs font-medium text-rail-text tabular-nums">
                    {Math.round(series.point.averageResponseTimeMs)} ms
                  </span>
                </div>
                <div
                  className="h-1.5 overflow-hidden rounded-full bg-rail-border"
                  aria-hidden="true"
                >
                  <div className={`h-full rounded-full ${series.tone.fill}`} style={{ width }} />
                </div>
                <div className="mt-2 flex justify-between gap-3 text-[11px] text-rail-muted">
                  <time dateTime={series.point.date}>{formatCompactDate(series.point.date)}</time>
                  <span>{series.point.sampleCount.toLocaleString()} samples</span>
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}

function utcDates(start: string, count: number): string[] {
  const first = new Date(start);
  return Array.from({ length: count }, (_, index) => {
    const date = new Date(first);
    date.setUTCDate(first.getUTCDate() + index);
    return date.toISOString().slice(0, 10);
  });
}

function formatChartDate(date: string): string {
  return new Intl.DateTimeFormat('en', {
    weekday: 'short',
    timeZone: 'UTC',
  }).format(new Date(`${date}T00:00:00.000Z`));
}

function formatCompactDate(date: string): string {
  return new Intl.DateTimeFormat('en', {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(`${date}T00:00:00.000Z`));
}

function contiguousSegments(
  dates: string[],
  pointsByDate: Map<string, ResponseTimeOverview['series'][number]['points'][number]>,
  xFor: (index: number) => number,
  yFor: (value: number) => number,
): Array<Array<{ x: number; y: number; date: string; value: number; sampleCount: number }>> {
  const segments: Array<
    Array<{ x: number; y: number; date: string; value: number; sampleCount: number }>
  > = [];
  let current: Array<{
    x: number;
    y: number;
    date: string;
    value: number;
    sampleCount: number;
  }> = [];
  dates.forEach((date, index) => {
    const point = pointsByDate.get(date);
    if (!point) {
      if (current.length > 0) segments.push(current);
      current = [];
      return;
    }
    current.push({
      x: xFor(index),
      y: yFor(point.averageResponseTimeMs),
      date,
      value: point.averageResponseTimeMs,
      sampleCount: point.sampleCount,
    });
  });
  if (current.length > 0) segments.push(current);
  return segments;
}

function smoothPath(points: Array<{ x: number; y: number }>): string {
  if (points.length === 1) return `M ${points[0]!.x} ${points[0]!.y} h 0.01`;
  return points.slice(1).reduce((path, point, index) => {
    const previous = points[index]!;
    const midpoint = (previous.x + point.x) / 2;
    return `${path} C ${midpoint} ${previous.y}, ${midpoint} ${point.y}, ${point.x} ${point.y}`;
  }, `M ${points[0]!.x} ${points[0]!.y}`);
}

function OverviewMetric({
  label,
  value,
  detail,
  tone = 'neutral',
  title,
}: {
  label: string;
  value: string;
  detail: string;
  tone?: 'neutral' | 'success' | 'danger';
  title?: string;
}) {
  const valueTone =
    tone === 'success'
      ? 'text-rail-success'
      : tone === 'danger'
        ? 'text-rail-danger'
        : 'text-rail-text';
  return (
    <div className="min-w-0 bg-rail-header px-4 py-3.5" title={title}>
      <dt className="text-xs text-rail-muted">{label}</dt>
      <dd
        className={`mt-2 mr-0 mb-0 ml-0 text-2xl font-medium tracking-tight tabular-nums ${valueTone}`}
      >
        {value}
      </dd>
      <dd className="mt-1 mr-0 mb-0 ml-0 truncate text-[11px] text-rail-muted">{detail}</dd>
    </div>
  );
}

function EmptyInsight({ children }: { children: ReactNode }) {
  return <p className="my-0 flex min-h-20 items-center text-sm text-rail-muted">{children}</p>;
}

function MonitorSnapshot({
  monitors,
  onDeleteMonitor,
}: {
  monitors: Monitor[];
  onDeleteMonitor?: ((monitor: Monitor) => void | Promise<void>) | undefined;
}) {
  const visible = [...monitors]
    .sort((left, right) => {
      const order = { attention: 0, pending: 1, paused: 2, operational: 3 } as const;
      return order[monitorCondition(left)] - order[monitorCondition(right)];
    })
    .slice(0, 8);

  return (
    <section
      className="overflow-hidden rounded-rail-panel border border-rail-border bg-rail-header"
      aria-labelledby="overview-monitors-heading"
    >
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-rail-border px-4 py-3">
        <div>
          <h2 id="overview-monitors-heading" className="m-0 text-sm font-medium text-rail-text">
            Monitored services
          </h2>
          <p className="mt-1 mb-0 text-xs text-rail-muted">
            Latest authoritative evidence, with attention required first
          </p>
        </div>
        <Link
          href="/monitors"
          className="inline-flex min-h-8 items-center rounded-rail-control px-2.5 text-xs font-medium text-rail-accent no-underline hover:bg-rail-hover"
        >
          View all monitors
        </Link>
      </div>
      {visible.length === 0 ? (
        <div className="flex min-h-36 flex-col items-start justify-center px-4 py-6">
          <p className="m-0 text-sm font-medium text-rail-text">No monitors yet</p>
          <p className="mt-1 mb-4 text-sm text-rail-muted">
            Create a monitor to begin collecting availability evidence.
          </p>
          <Link
            href="/monitors/new"
            className="inline-flex min-h-9 items-center rounded-rail-control bg-rail-accent px-3 text-sm font-medium text-rail-on-accent no-underline hover:bg-rail-accent-hover"
          >
            Create monitor
          </Link>
        </div>
      ) : (
        <MonitorTable monitors={visible} onDeleteMonitor={onDeleteMonitor} />
      )}
    </section>
  );
}
