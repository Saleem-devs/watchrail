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

const statusIcons: Record<MonitoringStatus, LucideIcon> = {
  UP: CircleCheck,
  DOWN: CircleX,
  DEGRADED: CircleAlert,
  UNKNOWN: CircleHelp,
  PAUSED: CirclePause,
};

export function StatusBadge({ status, label }: { status: MonitoringStatus; label?: string }) {
  const Icon = statusIcons[status];
  return (
    <span
      className={`inline-flex min-h-7 shrink-0 items-center gap-1.5 rounded-rail-control border px-2 py-1 text-xs font-semibold leading-none ${styles[status]}`}
      data-monitor-status={status}
      aria-label={label}
    >
      <Icon className="size-3.5" strokeWidth={1.75} aria-hidden="true" />
      {labels[status]}
    </span>
  );
}
import {
  CircleAlert,
  CircleCheck,
  CircleHelp,
  CirclePause,
  CircleX,
  type LucideIcon,
} from 'lucide-react';
