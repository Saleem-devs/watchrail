export type MonitoringStatus = 'UP' | 'DOWN' | 'DEGRADED' | 'UNKNOWN' | 'PAUSED';

const styles: Record<MonitoringStatus, string> = {
  UP: 'border-rail-success/35 bg-rail-success/10 text-rail-success',
  DOWN: 'border-rail-danger/35 bg-rail-danger/10 text-rail-danger',
  DEGRADED: 'border-rail-warning/35 bg-rail-warning/10 text-rail-warning',
  UNKNOWN: 'border-rail-border-strong bg-rail-surface text-rail-subtle',
  PAUSED: 'border-rail-border bg-rail-surface text-rail-subtle',
};

const labels: Record<MonitoringStatus, string> = {
  UP: 'Up',
  DOWN: 'Down',
  DEGRADED: 'Degraded',
  UNKNOWN: 'Unknown',
  PAUSED: 'Paused',
};

function StatusIcon({ status }: { status: MonitoringStatus }) {
  if (status === 'UP') {
    return <path d="m3.5 7 2.3 2.3 4.7-5" />;
  }
  if (status === 'DOWN') {
    return <path d="m4 4 6 6m0-6-6 6" />;
  }
  if (status === 'DEGRADED') {
    return <path d="M7 3v4.5m0 2.5v.1" />;
  }
  if (status === 'PAUSED') {
    return <path d="M5 4v6m4-6v6" />;
  }
  return <path d="M5.5 5.2A1.6 1.6 0 0 1 7 4.2c1 0 1.8.6 1.8 1.5 0 1.5-1.8 1.4-1.8 2.7m0 1.6v.1" />;
}

export function StatusBadge({ status, label }: { status: MonitoringStatus; label?: string }) {
  return (
    <span
      className={`inline-flex min-h-7 shrink-0 items-center gap-1.5 rounded-rail-control border px-2 py-1 text-xs font-semibold leading-none ${styles[status]}`}
      data-monitor-status={status}
      aria-label={label}
    >
      <svg
        viewBox="0 0 14 14"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="size-3.5"
        aria-hidden="true"
      >
        <circle cx="7" cy="7" r="5.5" />
        <StatusIcon status={status} />
      </svg>
      {labels[status]}
    </span>
  );
}
