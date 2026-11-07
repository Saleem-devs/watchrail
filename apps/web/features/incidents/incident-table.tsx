import Link from 'next/link';
import { DataTable, type DataTableColumn } from '../../components/ui/data-table';
import type { WorkspaceIncident } from './types';
import { monitorDetailHref } from '../../lib/navigation-origin';

const dateTimeFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeStyle: 'short',
});

function formatDateTime(value: string): string {
  return dateTimeFormatter.format(new Date(value));
}

function formatDuration(incident: WorkspaceIncident): string {
  const end = incident.resolvedAt ? new Date(incident.resolvedAt).getTime() : Date.now();
  const durationMs = Math.max(0, end - new Date(incident.startedAt).getTime());
  const minutes = Math.floor(durationMs / 60_000);
  if (minutes < 1) return '< 1 min';
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  if (hours < 24) return remainingMinutes > 0 ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  const remainingHours = hours % 24;
  return remainingHours > 0 ? `${days}d ${remainingHours}h` : `${days}d`;
}

function IncidentStatus({ incident }: { incident: WorkspaceIncident }) {
  const open = incident.status === 'OPEN';
  return (
    <span
      className={`inline-flex min-h-7 items-center gap-1.5 rounded-rail-control border px-2 py-1 text-xs font-semibold leading-none ${
        open
          ? 'border-rail-danger/35 bg-rail-danger/10 text-rail-danger'
          : 'border-rail-border-strong bg-rail-surface text-rail-subtle'
      }`}
    >
      <span
        className={`size-1.5 rounded-full ${open ? 'bg-rail-danger' : 'bg-rail-muted'}`}
        aria-hidden="true"
      />
      {open ? 'Open' : 'Resolved'}
    </span>
  );
}

function incidentColumns(
  origin: string,
  projectId?: string,
): Array<DataTableColumn<WorkspaceIncident>> {
  return [
    {
      id: 'monitor',
      header: 'Monitor',
      cell: (incident) => (
        <div className="min-w-0">
          <Link
            href={monitorDetailHref(incident.monitorId, origin, projectId)}
            className="font-medium text-rail-text no-underline hover:text-rail-accent hover:underline"
          >
            {incident.monitorName}
          </Link>
          <a
            href={incident.monitorUrl}
            target="_blank"
            rel="noreferrer"
            className="mt-0.5 block max-w-xs truncate text-xs text-rail-muted no-underline hover:text-rail-text hover:underline"
          >
            {incident.monitorUrl}
          </a>
        </div>
      ),
    },
    {
      id: 'impact',
      header: 'Impact',
      className: 'text-rail-subtle',
      cell: (incident) =>
        incident.severity === 'DOWN'
          ? 'Unavailable'
          : incident.severity === 'DEGRADED'
            ? 'Degraded'
            : 'Availability failure',
    },
    {
      id: 'started',
      header: 'Started',
      className: 'whitespace-nowrap text-rail-subtle tabular-nums',
      cell: (incident) => formatDateTime(incident.startedAt),
    },
    {
      id: 'duration',
      header: 'Duration',
      className: 'whitespace-nowrap text-rail-subtle tabular-nums',
      cell: formatDuration,
    },
    {
      id: 'status',
      header: 'Status',
      cell: (incident) => <IncidentStatus incident={incident} />,
    },
  ];
}

function incidentDetailHref(incident: WorkspaceIncident, projectId?: string): string | undefined {
  return projectId ? `/projects/${projectId}/incidents/${incident.id}` : undefined;
}

export function IncidentTable({
  incidents,
  origin,
  projectId,
  onAcknowledge,
  onSilence,
  onUnsilence,
  onResolve,
}: {
  incidents: WorkspaceIncident[];
  origin: string;
  projectId?: string | undefined;
  onAcknowledge: (incident: WorkspaceIncident) => void | Promise<void>;
  onSilence: (incident: WorkspaceIncident) => void;
  onUnsilence: (incident: WorkspaceIncident) => void | Promise<void>;
  onResolve: (incident: WorkspaceIncident) => void;
}) {
  return (
    <DataTable
      rows={incidents}
      columns={incidentColumns(origin, projectId)}
      actions={[
        {
          id: 'view-incident',
          label: 'View incident',
          href: (incident) =>
            incidentDetailHref(incident, projectId) ??
            monitorDetailHref(incident.monitorId, origin, projectId),
        },
        {
          id: 'acknowledge',
          label: 'Acknowledge',
          pendingLabel: 'Acknowledging…',
          visible: (incident) => incident.status === 'OPEN' && !incident.acknowledgedAt,
          onSelect: onAcknowledge,
        },
        {
          id: 'silence',
          label: 'Silence this incident',
          visible: (incident) => incident.status === 'OPEN' && !incident.notificationsSilenced,
          onSelect: onSilence,
        },
        {
          id: 'unsilence',
          label: 'Resume notifications',
          pendingLabel: 'Resuming…',
          visible: (incident) => incident.status === 'OPEN' && incident.notificationsSilenced,
          onSelect: onUnsilence,
        },
        {
          id: 'resolve',
          label: 'Resolve incident',
          tone: 'danger',
          visible: (incident) => incident.status === 'OPEN',
          onSelect: onResolve,
        },
        {
          id: 'view-monitor',
          label: 'View monitor',
          href: (incident) => monitorDetailHref(incident.monitorId, origin, projectId),
        },
      ]}
      getRowKey={(incident) => incident.id}
      getRowHref={(incident) =>
        incidentDetailHref(incident, projectId) ??
        monitorDetailHref(incident.monitorId, origin, projectId)
      }
      getRowLabel={(incident) => `${incident.monitorName} incident`}
      ariaLabel="Workspace incidents"
      minWidthClassName="min-w-[760px]"
    />
  );
}
