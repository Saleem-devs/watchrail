import { monitorCondition } from '../../lib/monitor-summary';
import type { StatusPageMonitor } from './types';

export function publicMonitorState(monitor: StatusPageMonitor | undefined): {
  label: string;
  className: string;
} {
  if (!monitor) {
    return { label: 'Unavailable', className: 'text-rail-muted' };
  }
  const condition = monitorCondition(monitor);
  if (condition === 'paused') {
    return { label: 'Monitoring impaired', className: 'text-rail-muted' };
  }
  if (condition === 'attention') {
    const label =
      monitor.currentCheck?.aggregateOutcome === 'DEGRADED' ? 'Partial outage' : 'Major outage';
    return { label, className: 'text-rail-danger' };
  }
  if (condition === 'operational') {
    return { label: 'Operational', className: 'text-rail-success' };
  }
  return { label: 'Monitoring impaired', className: 'text-rail-muted' };
}
