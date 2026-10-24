import { monitorCondition, type MonitorCondition } from '../../lib/monitor-summary';
import type { Monitor } from './types';

export type MonitorFilter = 'all' | MonitorCondition;

export function filterMonitors(
  monitors: readonly Monitor[],
  query: string,
  filter: MonitorFilter,
): Monitor[] {
  const needle = query.trim().toLowerCase();
  return monitors.filter((monitor) => {
    const matchesCondition = filter === 'all' || monitorCondition(monitor) === filter;
    const matchesQuery =
      !needle ||
      monitor.name.toLowerCase().includes(needle) ||
      monitor.url.toLowerCase().includes(needle);
    return matchesCondition && matchesQuery;
  });
}
