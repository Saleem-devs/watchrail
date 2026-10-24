export type MonitorCondition = 'operational' | 'attention' | 'paused' | 'pending';

/** Shared lifecycle-aware classifier for summary cards and inventory search. */
export function monitorCondition(monitor: MonitorSummaryInput): MonitorCondition {
  if (monitor.lifecycleState === 'PAUSED') return 'paused';
  const check = monitor.currentCheck;
  if (
    check?.availability === 'UNAVAILABLE' ||
    check?.aggregateOutcome === 'DEGRADED' ||
    check?.aggregateOutcome === 'DOWN'
  )
    return 'attention';
  if (
    check?.availability === 'AVAILABLE' &&
    (check.aggregateOutcome == null || check.aggregateOutcome === 'UP')
  )
    return 'operational';
  return 'pending';
}

export interface MonitorSummaryInput {
  lifecycleState: 'ENABLED' | 'PAUSED';
  currentCheck?: {
    availability: 'AVAILABLE' | 'UNAVAILABLE' | 'UNKNOWN';
    aggregateOutcome?: 'UP' | 'DEGRADED' | 'DOWN' | 'UNKNOWN' | null;
  } | null;
  incidentState?: { currentIncident?: { id: string } | null } | null;
}

export interface MonitorSummary {
  total: number;
  operational: number;
  needsAttention: number;
  paused: number;
  pending: number;
  openIncidents: number;
}

export function summarizeMonitors(monitors: readonly MonitorSummaryInput[]): MonitorSummary {
  const result: MonitorSummary = {
    total: monitors.length,
    operational: 0,
    needsAttention: 0,
    paused: 0,
    pending: 0,
    openIncidents: 0,
  };

  for (const monitor of monitors) {
    if (monitor.incidentState?.currentIncident) result.openIncidents += 1;

    const condition = monitorCondition(monitor);
    if (condition === 'operational') result.operational += 1;
    else if (condition === 'attention') result.needsAttention += 1;
    else if (condition === 'paused') result.paused += 1;
    else result.pending += 1;
  }

  return result;
}
