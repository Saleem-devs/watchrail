import { formatPercent } from './formatting';
import { monitorTypeDefinition, type MonitorType } from './monitor-types';
import type { Monitor, MonitorListSummary } from './types';

function averageLatency(monitors: Monitor[]): number | null {
  const values = monitors.flatMap((monitor) =>
    monitor.currentCheck?.responseTimeMs == null ? [] : [monitor.currentCheck.responseTimeMs],
  );
  return values.length === 0
    ? null
    : values.reduce((total, value) => total + value, 0) / values.length;
}

function supportingMetric(
  type: MonitorType,
  monitors: Monitor[],
): { label: string; value: string } {
  if (type === 'HTTP') {
    const protectedCount = monitors.filter(
      (monitor) => monitor.tlsPolicy && monitor.tlsPolicy.type !== 'DISABLED',
    ).length;
    return { label: 'TLS policy enabled', value: String(protectedCount) };
  }
  if (type === 'DNS') {
    const assertedCount = monitors.filter(
      (monitor) =>
        monitor.configuration.type === 'DNS' && monitor.configuration.expectedValues.length > 0,
    ).length;
    return { label: 'Answer policies', value: String(assertedCount) };
  }
  if (type === 'API_WORKFLOW') {
    const stepCount = monitors.reduce(
      (total, monitor) =>
        total +
        (monitor.configuration.type === 'API_WORKFLOW'
          ? monitor.configuration.workflow.steps.length
          : 0),
      0,
    );
    return { label: 'Configured steps', value: String(stepCount) };
  }
  if (type === 'HEARTBEAT') {
    const runtimePolicies = monitors.filter(
      (monitor) =>
        monitor.configuration.type === 'HEARTBEAT' &&
        monitor.configuration.heartbeat.maximumRuntimeSeconds != null,
    ).length;
    return { label: 'Runtime policies', value: String(runtimePolicies) };
  }
  if (type === 'DOMAIN_EXPIRY') {
    return { label: 'Renewal policies', value: String(monitors.length) };
  }
  if (type === 'KEYWORD') {
    return { label: 'Content rules', value: String(monitors.length) };
  }
  return {
    label: 'Active locations',
    value: String(new Set(monitors.flatMap((m) => m.locations)).size),
  };
}

function Metric({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <div className="min-w-0 px-5 py-4 sm:px-6">
      <p className="m-0 text-xs font-medium text-rail-muted">{label}</p>
      <p className="mt-2 mb-0 text-2xl font-semibold tracking-tight text-rail-text tabular-nums">
        {value}
      </p>
      <p className="mt-1 mb-0 truncate text-xs text-rail-muted">{detail}</p>
    </div>
  );
}

export function MonitorTypeOverview({
  type,
  monitors,
  summary,
}: {
  type: MonitorType;
  monitors: Monitor[];
  summary?: MonitorListSummary | undefined;
}) {
  const definition = monitorTypeDefinition(type);
  const latency = type === 'HEARTBEAT' ? null : averageLatency(monitors);
  const supporting = supportingMetric(type, monitors);
  const latencyLabel =
    type === 'TCP'
      ? 'Average connect latency'
      : type === 'DNS'
        ? 'Average lookup latency'
        : type === 'ICMP'
          ? 'Average round-trip time'
          : type === 'DOMAIN_EXPIRY'
            ? 'Average RDAP lookup'
            : type === 'API_WORKFLOW'
              ? 'Average workflow duration'
              : 'Average response latency';

  return (
    <section
      className="mt-6 overflow-hidden rounded-rail-panel border border-rail-border bg-rail-header"
      aria-labelledby="type-health-heading"
    >
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-rail-border px-5 py-4 sm:px-6">
        <div>
          <h2 id="type-health-heading" className="m-0 text-sm font-semibold text-rail-text">
            {definition.label} health
          </h2>
          <p className="mt-1 mb-0 text-xs text-rail-muted">
            Current authoritative state and protocol-specific signals.
          </p>
        </div>
        <span className="text-xs text-rail-muted">Latest evidence</span>
      </div>
      <div className="grid divide-y divide-rail-border sm:grid-cols-2 sm:divide-x sm:divide-y-0 xl:grid-cols-4">
        <Metric
          label="Operational"
          value={String(summary?.operational ?? 0)}
          detail={`${summary?.total ?? 0} total monitors`}
        />
        <Metric
          label="Needs attention"
          value={String(summary?.attention ?? 0)}
          detail={`${summary?.openIncidents ?? 0} open incidents`}
        />
        <Metric
          label={type === 'HEARTBEAT' ? 'Evidence coverage' : latencyLabel}
          value={
            type === 'HEARTBEAT'
              ? formatPercent(summary?.averageCoveragePercent ?? null)
              : latency == null
                ? '—'
                : `${Math.round(latency)} ms`
          }
          detail={type === 'HEARTBEAT' ? 'Average 7-day coverage' : 'Latest completed checks'}
        />
        <Metric label={supporting.label} value={supporting.value} detail="Configured monitors" />
      </div>
    </section>
  );
}
