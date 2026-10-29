'use client';

import { useEffect, useState } from 'react';
import { Button } from '../../components/ui/button';
import type {
  AvailabilityHistory,
  AvailabilityHistoryRange,
  AvailabilityHistoryStatus,
} from './types';

const ranges: Array<{ value: AvailabilityHistoryRange; label: string }> = [
  { value: '24h', label: '24 hours' },
  { value: '7d', label: '7 days' },
  { value: '30d', label: '30 days' },
  { value: '90d', label: '90 days' },
];

const statusStyles: Record<AvailabilityHistoryStatus, string> = {
  UP: 'bg-rail-accent',
  DEGRADED: 'bg-rail-warning',
  DOWN: 'bg-rail-danger',
  UNKNOWN: 'bg-rail-muted',
  NO_DATA: 'bg-rail-border-strong',
};

const statusLabels: Record<AvailabilityHistoryStatus, string> = {
  UP: 'Operational',
  DEGRADED: 'Degraded',
  DOWN: 'Down',
  UNKNOWN: 'Unknown',
  NO_DATA: 'No evidence',
};

export function MonitorAvailabilityHistory({ monitorId }: { monitorId: string }) {
  const [range, setRange] = useState<AvailabilityHistoryRange>('7d');
  const [history, setHistory] = useState<AvailabilityHistory>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();

  useEffect(() => {
    const controller = new AbortController();
    void fetch(`/api/monitors/${monitorId}/availability-history?range=${range}`, {
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) throw new Error('Could not load availability history.');
        const body = (await response.json()) as { data?: AvailabilityHistory };
        if (!body.data) throw new Error('The API returned no availability history.');
        setHistory(body.data);
      })
      .catch((reason: unknown) => {
        if (reason instanceof DOMException && reason.name === 'AbortError') return;
        setError('Availability history is temporarily unavailable.');
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [monitorId, range]);

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="m-0 text-sm font-semibold text-rail-text">Availability history</h3>
          <p className="mt-1 mb-0 text-xs text-rail-muted">
            Authoritative check outcomes grouped across the selected period.
          </p>
        </div>
        <div
          className="flex items-center gap-4 border-b border-rail-border"
          role="group"
          aria-label="Availability history range"
        >
          {ranges.map((option) => (
            <Button
              key={option.value}
              variant="quiet"
              size="compact"
              className={`relative min-h-8 rounded-none border-0 bg-transparent px-0 py-1 shadow-none hover:bg-transparent ${
                range === option.value
                  ? 'font-medium text-rail-text after:absolute after:inset-x-0 after:bottom-[-1px] after:h-px after:bg-rail-accent'
                  : 'text-rail-muted hover:text-rail-text'
              }`}
              aria-pressed={range === option.value}
              onClick={() => {
                if (option.value === range) return;
                setLoading(true);
                setError(undefined);
                setHistory(undefined);
                setRange(option.value);
              }}
            >
              {option.label}
            </Button>
          ))}
        </div>
      </div>

      <div className="mt-5 min-h-20" aria-live="polite">
        {loading && !history ? (
          <div className="flex h-12 items-center text-xs text-rail-muted" role="status">
            Loading availability history…
          </div>
        ) : error ? (
          <p className="m-0 flex h-12 items-center text-xs text-rail-danger">{error}</p>
        ) : history ? (
          <AvailabilityStrip history={history} />
        ) : null}
      </div>
    </div>
  );
}

function AvailabilityStrip({ history }: { history: AvailabilityHistory }) {
  return (
    <figure className="m-0" aria-label={`${rangeLabel(history.range.key)} availability history`}>
      <div
        className="grid h-12 items-stretch gap-1 sm:gap-1.5"
        style={{ gridTemplateColumns: `repeat(${history.buckets.length}, minmax(3px, 1fr))` }}
      >
        {history.buckets.map((bucket, index) => {
          const label = bucketAccessibleLabel(bucket);
          const edgeClass =
            index < 4
              ? 'left-0'
              : index >= history.buckets.length - 4
                ? 'right-0'
                : 'left-1/2 -translate-x-1/2';
          return (
            <div
              key={bucket.start}
              className="group relative min-w-0 rounded-[2px] focus-visible:z-20 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-rail-accent"
              tabIndex={0}
              role="img"
              aria-label={label}
            >
              <span
                className={`block h-full w-full rounded-[2px] ${statusStyles[bucket.status]}`}
                aria-hidden="true"
              />
              <span
                className={`pointer-events-none absolute bottom-[calc(100%+8px)] z-30 hidden w-max max-w-64 rounded-rail-control border border-rail-border-strong bg-rail-raised px-3 py-2 text-left shadow-lg group-hover:block group-focus-visible:block ${edgeClass}`}
                aria-hidden="true"
              >
                <strong className="block text-xs font-semibold text-rail-text">
                  {statusLabels[bucket.status]}
                </strong>
                <span className="mt-0.5 block text-xs text-rail-muted">
                  {formatBucketRange(bucket.start, bucket.end)}
                </span>
                <span className="mt-1 block text-xs text-rail-subtle">
                  {bucket.checks === 0
                    ? 'No checks recorded'
                    : `${bucket.checks} ${bucket.checks === 1 ? 'check' : 'checks'} · ${bucket.up} up · ${bucket.down} down`}
                </span>
              </span>
            </div>
          );
        })}
      </div>
      <figcaption className="mt-2 flex items-center justify-between gap-4 text-xs text-rail-muted">
        <time dateTime={history.range.start}>{formatRangeEdge(history.range.start)}</time>
        <span>{history.buckets.reduce((total, bucket) => total + bucket.checks, 0)} checks</span>
        <time dateTime={history.range.end}>{formatRangeEdge(history.range.end)}</time>
      </figcaption>
      <div
        className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-rail-muted"
        aria-label="Availability status legend"
      >
        {(['UP', 'DEGRADED', 'DOWN', 'UNKNOWN', 'NO_DATA'] as const).map((status) => (
          <span key={status} className="inline-flex items-center gap-1.5">
            <span className={`size-2 rounded-[2px] ${statusStyles[status]}`} aria-hidden="true" />
            {statusLabels[status]}
          </span>
        ))}
      </div>
    </figure>
  );
}

function bucketAccessibleLabel(bucket: AvailabilityHistory['buckets'][number]): string {
  const range = formatBucketRange(bucket.start, bucket.end);
  if (bucket.checks === 0) return `${range}: no evidence.`;
  return `${range}: ${statusLabels[bucket.status]}. ${bucket.checks} ${bucket.checks === 1 ? 'check' : 'checks'}, ${bucket.up} up, ${bucket.down} down, ${bucket.degraded} degraded, ${bucket.unknown} unknown.`;
}

function formatBucketRange(start: string, end: string): string {
  const startDate = new Date(start);
  const endDate = new Date(end);
  const sameDay = startDate.toDateString() === endDate.toDateString();
  if (sameDay) {
    return `${startDate.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}, ${startDate.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}–${endDate.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`;
  }
  return `${startDate.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric' })}–${endDate.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric' })}`;
}

function formatRangeEdge(value: string): string {
  return new Date(value).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function rangeLabel(range: AvailabilityHistoryRange): string {
  return ranges.find((option) => option.value === range)?.label ?? range;
}
