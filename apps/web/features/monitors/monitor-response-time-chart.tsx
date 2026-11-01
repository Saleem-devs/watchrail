'use client';

import { useMemo, useState } from 'react';
import { Button } from '../../components/ui/button';
import type { HistoryPage, ManualRound } from './types';
import type { Monitor } from './types';

type TriggerFilter = 'ALL' | ManualRound['trigger'];

const filters: Array<{ value: TriggerFilter; label: string }> = [
  { value: 'ALL', label: 'All' },
  { value: 'SCHEDULED', label: 'Scheduled' },
  { value: 'MANUAL', label: 'Manual' },
];

export function MonitorResponseTimeChart({
  page,
  loading,
  protocol = 'HTTP',
}: {
  page: HistoryPage | undefined;
  loading: boolean;
  protocol?: Monitor['type'];
}) {
  const [filter, setFilter] = useState<TriggerFilter>('ALL');
  const points = useMemo(() => responseTimePoints(page, filter), [page, filter]);

  return (
    <section className="overflow-hidden rounded-rail-panel border border-rail-border bg-rail-raised">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-rail-border px-5 py-4 sm:px-6">
        <div>
          <h2 className="m-0 text-sm font-semibold text-rail-text">Latency</h2>
          <p className="mt-1 mb-0 text-xs text-rail-muted">
            {protocol === 'TCP'
              ? 'Connection establishment time from the latest recorded checks.'
              : protocol === 'DNS'
                ? 'DNS query duration from the latest recorded checks.'
                : 'Total HTTP response duration from the latest recorded checks.'}
          </p>
        </div>
        <div
          className="flex items-center gap-4 border-b border-rail-border"
          role="group"
          aria-label="Filter latency by check type"
        >
          {filters.map((option) => (
            <Button
              key={option.value}
              variant="quiet"
              size="compact"
              className={`relative min-h-8 rounded-none border-0 bg-transparent px-0 py-1 shadow-none hover:bg-transparent ${
                filter === option.value
                  ? 'font-medium text-rail-text after:absolute after:inset-x-0 after:bottom-[-1px] after:h-px after:bg-rail-accent'
                  : 'text-rail-muted hover:text-rail-text'
              }`}
              aria-pressed={filter === option.value}
              onClick={() => setFilter(option.value)}
            >
              {option.label}
            </Button>
          ))}
        </div>
      </div>
      <div className="px-5 py-5 sm:px-6">
        {loading && !page ? (
          <div
            className="flex min-h-64 items-center justify-center text-xs text-rail-muted"
            role="status"
          >
            Loading latency evidence…
          </div>
        ) : points.length < 2 ? (
          <div className="flex min-h-64 flex-col items-center justify-center text-center">
            <strong className="text-sm font-medium text-rail-text">
              Not enough latency evidence yet
            </strong>
            <p className="mt-1 mb-0 max-w-sm text-xs leading-5 text-rail-muted">
              Watchrail needs at least two completed {filter === 'ALL' ? '' : filter.toLowerCase()}{' '}
              checks with latency evidence to draw a trend.
            </p>
          </div>
        ) : (
          <ResponseTimePlot points={points} />
        )}
      </div>
    </section>
  );
}

interface ResponseTimePoint {
  id: string;
  responseTimeMs: number;
  checkedAt: string;
  outcome: 'PASS' | 'FAIL' | 'UNKNOWN';
  trigger: ManualRound['trigger'];
}

function responseTimePoints(
  page: HistoryPage | undefined,
  filter: TriggerFilter,
): ResponseTimePoint[] {
  return (page?.items ?? [])
    .flatMap((round): ResponseTimePoint[] => {
      if (filter !== 'ALL' && round.trigger !== filter) return [];
      if (!round.result || round.result.kind === 'MULTI_LOCATION') return [];
      if (round.result.responseTimeMs == null) return [];
      return [
        {
          id: round.id,
          responseTimeMs: round.result.responseTimeMs,
          checkedAt: round.result.checkedAt,
          outcome: round.result.outcome,
          trigger: round.trigger,
        },
      ];
    })
    .sort((left, right) => Date.parse(left.checkedAt) - Date.parse(right.checkedAt));
}

function ResponseTimePlot({ points }: { points: ResponseTimePoint[] }) {
  const width = 1400;
  const height = 276;
  const plot = { left: 58, right: 18, top: 16, bottom: 42 };
  const chartWidth = width - plot.left - plot.right;
  const chartHeight = height - plot.top - plot.bottom;
  const maximum = Math.max(...points.map((point) => point.responseTimeMs));
  const yMaximum = Math.max(100, Math.ceil(maximum / 100) * 100);
  const position = (point: ResponseTimePoint, index: number) => ({
    x: plot.left + (index / (points.length - 1)) * chartWidth,
    y: plot.top + chartHeight - (point.responseTimeMs / yMaximum) * chartHeight,
  });
  const path = points
    .map((point, index) => {
      const { x, y } = position(point, index);
      return `${index === 0 ? 'M' : 'L'} ${x.toFixed(2)} ${y.toFixed(2)}`;
    })
    .join(' ');
  const tickValues = [1, 0.75, 0.5, 0.25, 0];
  const labelIndexes = new Set([
    0,
    Math.floor((points.length - 1) / 3),
    Math.floor(((points.length - 1) * 2) / 3),
    points.length - 1,
  ]);
  const summary = `${points.length} latency measurements. Latest ${Math.round(
    points.at(-1)?.responseTimeMs ?? 0,
  )} milliseconds. Slowest ${Math.round(maximum)} milliseconds.`;

  return (
    <figure className="m-0 overflow-x-auto" aria-label="Latency trend">
      <p className="sr-only">{summary}</p>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="block h-auto w-full min-w-[42rem]"
        role="img"
        aria-label={summary}
      >
        {tickValues.map((ratio) => {
          const y = plot.top + (1 - ratio) * chartHeight;
          return (
            <g key={ratio}>
              <line
                x1={plot.left}
                x2={width - plot.right}
                y1={y}
                y2={y}
                stroke="var(--color-rail-border)"
                strokeWidth="1"
                strokeDasharray={ratio === 0 ? undefined : '3 5'}
              />
              <text
                x={plot.left - 12}
                y={y + 4}
                textAnchor="end"
                fill="var(--color-rail-muted)"
                fontSize="11"
              >
                {Math.round(yMaximum * ratio)} ms
              </text>
            </g>
          );
        })}
        <path
          d={path}
          fill="none"
          stroke="var(--color-rail-accent)"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          vectorEffect="non-scaling-stroke"
        />
        {points.map((point, index) => {
          const { x, y } = position(point, index);
          const failed = point.outcome === 'FAIL';
          const showLabel = labelIndexes.has(index);
          return (
            <g key={point.id}>
              <circle
                cx={x}
                cy={y}
                r="4"
                fill={failed ? 'var(--color-rail-danger)' : 'var(--color-rail-accent)'}
                stroke="var(--color-rail-raised)"
                strokeWidth="2"
                tabIndex={0}
                role="img"
                aria-label={`${new Date(point.checkedAt).toLocaleString()}: ${Math.round(
                  point.responseTimeMs,
                )} milliseconds, ${point.outcome.toLowerCase()}, ${point.trigger.toLowerCase()} check`}
              >
                <title>
                  {new Date(point.checkedAt).toLocaleString()} · {Math.round(point.responseTimeMs)}{' '}
                  ms · {point.outcome.toLowerCase()}
                </title>
              </circle>
              {showLabel ? (
                <text
                  x={x}
                  y={height - 14}
                  textAnchor={
                    index === 0 ? 'start' : index === points.length - 1 ? 'end' : 'middle'
                  }
                  fill="var(--color-rail-muted)"
                  fontSize="11"
                >
                  {formatChartTime(point.checkedAt)}
                </text>
              ) : null}
            </g>
          );
        })}
      </svg>
      <figcaption className="mt-3 flex flex-wrap items-center justify-between gap-3 border-t border-rail-border pt-3 text-xs text-rail-muted">
        <span className="flex flex-wrap items-center gap-4">
          <span className="inline-flex items-center gap-1.5">
            <span className="size-2 rounded-full bg-rail-accent" aria-hidden="true" />
            Latency
          </span>
          {points.some((point) => point.outcome === 'FAIL') ? (
            <span className="inline-flex items-center gap-1.5">
              <span className="size-2 rounded-full bg-rail-danger" aria-hidden="true" />
              Failed check
            </span>
          ) : null}
        </span>
        <span>Latest {points.length} checks with timing evidence</span>
      </figcaption>
    </figure>
  );
}

function formatChartTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(value));
}
