import { Dashboard } from '../../../dashboard';
import {
  monitorFiltersFromSearchParams,
  monitorPaginationFromSearchParams,
} from '../../../../features/monitors/filter-monitors';

export default async function ProjectMonitorsPage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { projectId } = await params;
  const values = await searchParams;
  const query = new URLSearchParams();
  for (const key of ['name', 'state', 'location', 'page', 'limit'] as const) {
    const value = values[key];
    if (typeof value === 'string') query.set(key, value);
  }
  return (
    <Dashboard
      view="monitors"
      projectId={projectId}
      initialMonitorFilters={monitorFiltersFromSearchParams(query)}
      initialMonitorPagination={monitorPaginationFromSearchParams(query)}
    />
  );
}
