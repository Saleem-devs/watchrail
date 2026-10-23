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

    // A retained historical result must not make an inactive monitor look operational.
    if (monitor.lifecycleState === 'PAUSED') {
      result.paused += 1;
      continue;
    }

    const check = monitor.currentCheck;
    if (
      check?.availability === 'UNAVAILABLE' ||
      check?.aggregateOutcome === 'DEGRADED' ||
      check?.aggregateOutcome === 'DOWN'
    ) {
      result.needsAttention += 1;
    } else if (
      check?.availability === 'AVAILABLE' &&
      (check.aggregateOutcome == null || check.aggregateOutcome === 'UP')
    ) {
      result.operational += 1;
    } else {
      // No check, unknown result or insufficient regional evidence is not healthy.
      result.pending += 1;
    }
  }

  return result;
}
