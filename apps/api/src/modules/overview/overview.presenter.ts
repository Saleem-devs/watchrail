import type { ResponseTimeOverview } from '@watchrail/db';

export function responseTimeOverviewResponse(overview: ResponseTimeOverview) {
  return {
    range: {
      start: overview.range.start.toISOString(),
      end: overview.range.end.toISOString(),
      timezone: 'UTC' as const,
    },
    series: overview.series,
  };
}
