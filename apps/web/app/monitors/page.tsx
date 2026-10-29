import { Dashboard } from '../dashboard';
import {
  monitorFiltersFromSearchParams,
  monitorPaginationFromSearchParams,
} from '../../features/monitors/filter-monitors';

export default async function MonitorsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const values = await searchParams;
  const params = new URLSearchParams();
  for (const key of ['name', 'state', 'location', 'page', 'limit'] as const) {
    const value = values[key];
    if (typeof value === 'string') params.set(key, value);
  }
  return (
    <Dashboard
      view="monitors"
      initialMonitorFilters={monitorFiltersFromSearchParams(params)}
      initialMonitorPagination={monitorPaginationFromSearchParams(params)}
    />
  );
}
