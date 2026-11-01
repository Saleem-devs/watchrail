import { monitorCondition, type MonitorCondition } from '../../lib/monitor-summary';
import type { Monitor } from './types';

export type MonitorFilter = 'all' | MonitorCondition;

export interface MonitorListFilters {
  name: string;
  state: MonitorFilter;
  location: string;
}

export interface MonitorListPagination {
  page: number;
  limit: number;
}

export const DEFAULT_MONITOR_PAGINATION: MonitorListPagination = { page: 1, limit: 25 };

export const EMPTY_MONITOR_FILTERS: MonitorListFilters = {
  name: '',
  state: 'all',
  location: '',
};

export function monitorFiltersFromSearchParams(params: URLSearchParams): MonitorListFilters {
  const state = params.get('state');
  return {
    name: params.get('name') ?? '',
    state:
      state === 'operational' || state === 'attention' || state === 'paused' || state === 'pending'
        ? state
        : 'all',
    location: params.get('location') ?? '',
  };
}

export function monitorFiltersToSearchParams(filters: MonitorListFilters): URLSearchParams {
  const params = new URLSearchParams();
  if (filters.name.trim()) params.set('name', filters.name.trim());
  if (filters.state !== 'all') params.set('state', filters.state);
  if (filters.location) params.set('location', filters.location);
  return params;
}

export function monitorPaginationFromSearchParams(params: URLSearchParams): MonitorListPagination {
  const requestedPage = Number(params.get('page'));
  const requestedLimit = Number(params.get('limit'));
  return {
    page: Number.isSafeInteger(requestedPage) && requestedPage > 0 ? requestedPage : 1,
    limit: [10, 25, 50, 100].includes(requestedLimit) ? requestedLimit : 25,
  };
}

export function monitorListSearchParams(
  filters: MonitorListFilters,
  pagination: MonitorListPagination,
): URLSearchParams {
  const params = monitorFiltersToSearchParams(filters);
  params.set('page', String(pagination.page));
  params.set('limit', String(pagination.limit));
  return params;
}

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
      monitor.url.toLowerCase().includes(needle) ||
      (monitor.configuration?.type === 'TCP' &&
        `${monitor.configuration.host}:${monitor.configuration.port}`
          .toLowerCase()
          .includes(needle));
    return matchesCondition && matchesQuery;
  });
}
