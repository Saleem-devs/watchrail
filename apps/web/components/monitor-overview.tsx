import { summarizeMonitors, type MonitorSummaryInput } from '../lib/monitor-summary';

const tones = {
  neutral: 'bg-rail-muted',
  positive: 'bg-rail-success',
  negative: 'bg-rail-danger',
} as const;

export function MonitorOverview({ monitors }: { monitors: readonly MonitorSummaryInput[] }) {
  const summary = summarizeMonitors(monitors);
  const stats = [
    { label: 'Total monitors', value: summary.total, tone: 'neutral' },
    { label: 'Operational', value: summary.operational, tone: 'positive' },
    { label: 'Needs attention', value: summary.needsAttention, tone: 'negative' },
    { label: 'Awaiting evidence', value: summary.pending, tone: 'neutral' },
  ] as const;
  return (
    <section className="my-7" aria-label="Monitor overview">
      <div className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="m-0 text-lg font-semibold tracking-tight text-rail-text">At a glance</h2>
        <span className="text-xs text-rail-muted">Based on the latest reported checks</span>
      </div>
      <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        {stats.map((stat) => (
          <div
            key={stat.label}
            className="flex min-h-28 flex-col justify-between rounded-xl border border-rail-border bg-rail-raised p-4 sm:min-h-32 sm:p-5"
          >
            <div className="flex items-center gap-2 text-xs font-medium text-rail-subtle">
              <span
                className={`size-2 shrink-0 rounded-full ${tones[stat.tone]}`}
                aria-hidden="true"
              />
              <span>{stat.label}</span>
            </div>
            <strong className="text-3xl font-bold tracking-tight text-rail-text tabular-nums">
              {stat.value}
            </strong>
          </div>
        ))}
      </div>
      {summary.openIncidents > 0 && (
        <p className="mt-3 text-xs text-rail-danger" role="status">
          {summary.openIncidents} {summary.openIncidents === 1 ? 'monitor has' : 'monitors have'} an
          open incident.
        </p>
      )}
    </section>
  );
}
