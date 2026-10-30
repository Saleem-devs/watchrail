import { summarizeMonitors, type MonitorSummaryInput } from '../lib/monitor-summary';

const tones = {
  neutral: 'text-rail-muted',
  positive: 'text-rail-success',
  negative: 'text-rail-danger',
} as const;

export function MonitorOverview({ monitors }: { monitors: readonly MonitorSummaryInput[] }) {
  const summary = summarizeMonitors(monitors);
  const stats = [
    { label: 'Total monitors', value: summary.total, tone: 'neutral' },
    { label: 'Operational', value: summary.operational, tone: 'positive' },
    { label: 'Needs attention', value: summary.needsAttention, tone: 'negative' },
    { label: 'Paused', value: summary.paused, tone: 'neutral' },
    { label: 'Awaiting evidence', value: summary.pending, tone: 'neutral' },
  ] as const;
  return (
    <section
      className="my-6 overflow-hidden rounded-rail-panel border border-rail-border bg-rail-header"
      aria-label="Monitor overview"
    >
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-rail-border px-4 py-3">
        <h2 className="m-0 text-sm font-semibold text-rail-text">Project health</h2>
        <span className="text-xs text-rail-muted">Latest authoritative state</span>
      </div>
      <dl className="grid grid-cols-2 gap-px bg-rail-border sm:grid-cols-3 xl:grid-cols-5">
        {stats.map((stat) => (
          <div
            key={stat.label}
            className="flex min-h-20 flex-col justify-between gap-2 bg-rail-header px-4 py-3"
          >
            <dt className="text-xs font-medium text-rail-subtle">{stat.label}</dt>
            <dd
              className={`m-0 text-2xl font-semibold tracking-tight tabular-nums ${tones[stat.tone]}`}
            >
              {stat.value}
            </dd>
          </div>
        ))}
      </dl>
      {summary.openIncidents > 0 && (
        <p
          className="m-0 border-t border-rail-danger/25 bg-rail-danger/5 px-4 py-3 text-xs font-medium text-rail-danger"
          role="status"
        >
          {summary.openIncidents} {summary.openIncidents === 1 ? 'monitor has' : 'monitors have'} an
          open incident.
        </p>
      )}
    </section>
  );
}
