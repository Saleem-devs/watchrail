import Link from 'next/link';
import {
  DataTable,
  type DataTableAction,
  type DataTableColumn,
} from '../../components/ui/data-table';
import { StatusBadge } from '../../components/ui/status-badge';
import { formatPercent, monitorStateLabel, monitorStatus } from './formatting';
import type { Monitor } from './types';
import { monitorDetailHref, monitorEditHref } from '../../lib/navigation-origin';

function formatLocations(locations: string[]): string {
  if (locations.length === 0) return '—';
  if (locations.length <= 2) return locations.join(', ');
  return `${locations[0]} +${locations.length - 1}`;
}

function monitorColumns(origin: string): Array<DataTableColumn<Monitor>> {
  return [
    {
      id: 'monitor',
      header: 'Monitor',
      cell: (monitor) => (
        <div className="min-w-0">
          <Link
            href={monitorDetailHref(monitor.id, origin)}
            className="font-medium text-rail-text no-underline hover:text-rail-accent hover:underline"
          >
            {monitor.name}
          </Link>
          <a
            href={monitor.url}
            target="_blank"
            rel="noreferrer"
            aria-label={`Open ${monitor.name} endpoint in a new tab`}
            className="mt-0.5 block max-w-xs truncate text-xs text-rail-muted no-underline hover:text-rail-text hover:underline"
          >
            {monitor.url}
          </a>
        </div>
      ),
    },
    {
      id: 'uptime',
      header: '7-day uptime',
      className: 'text-rail-subtle tabular-nums',
      cell: (monitor) => formatPercent(monitor.uptime?.uptimePercent),
    },
    {
      id: 'coverage',
      header: 'Evidence coverage',
      className: 'text-rail-subtle tabular-nums',
      cell: (monitor) => formatPercent(monitor.uptime?.coveragePercent),
    },
    {
      id: 'response',
      header: 'Latest response',
      className: 'text-rail-subtle tabular-nums',
      cell: (monitor) =>
        monitor.lifecycleState === 'PAUSED' || monitor.currentCheck?.responseTimeMs == null
          ? '—'
          : `${Math.round(monitor.currentCheck.responseTimeMs)} ms`,
    },
    {
      id: 'locations',
      header: 'Locations',
      className: 'text-rail-subtle',
      cell: (monitor) => formatLocations(monitor.locations),
    },
    {
      id: 'state',
      header: 'Current state',
      cell: (monitor) => (
        <StatusBadge
          status={monitorStatus(monitor.lifecycleState, monitor.currentCheck)}
          label={monitorStateLabel(monitor.lifecycleState, monitor.currentCheck)}
        />
      ),
    },
  ];
}

export function MonitorTable({
  monitors,
  onDeleteMonitor,
  extraActions = [],
  origin = '/monitors',
}: {
  monitors: Monitor[];
  onDeleteMonitor?: ((monitor: Monitor) => void | Promise<void>) | undefined;
  extraActions?: Array<DataTableAction<Monitor>>;
  origin?: string;
}) {
  const actions: Array<DataTableAction<Monitor>> = [
    { id: 'view', label: 'View', href: (monitor) => monitorDetailHref(monitor.id, origin) },
    {
      id: 'edit',
      label: 'Edit',
      href: (monitor) => monitorEditHref(monitor.id, origin),
    },
    ...extraActions,
  ];
  if (onDeleteMonitor) {
    actions.push({
      id: 'delete',
      label: 'Delete',
      pendingLabel: 'Deleting…',
      tone: 'danger',
      onSelect: onDeleteMonitor,
    });
  }

  return (
    <DataTable
      rows={monitors}
      columns={monitorColumns(origin)}
      actions={actions}
      getRowKey={(monitor) => monitor.id}
      getRowHref={(monitor) => monitorDetailHref(monitor.id, origin)}
      getRowLabel={(monitor) => monitor.name}
      ariaLabel="Monitored services"
    />
  );
}
