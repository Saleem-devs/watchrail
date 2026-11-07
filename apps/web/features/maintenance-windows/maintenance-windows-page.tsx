'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { Plus, X } from 'lucide-react';
import { AppShell } from '../../components/app-shell';
import { actionClassName, Button } from '../../components/ui/button';
import { ConfirmationDialog } from '../../components/ui/confirmation-dialog';
import {
  DataTable,
  type DataTableAction,
  type DataTableColumn,
} from '../../components/ui/data-table';
import { PageHeader } from '../../components/ui/page-header';
import {
  archiveMaintenanceWindow,
  listMaintenanceWindows,
  MaintenanceWindowRequestError,
} from './maintenance-window-api';
import type { MaintenanceWindow } from './types';

const dateFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeStyle: 'short',
});

export function MaintenanceWindowsPage({ projectId }: { projectId: string }) {
  const [windows, setWindows] = useState<MaintenanceWindow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [archiveTarget, setArchiveTarget] = useState<MaintenanceWindow | null>(null);

  const load = useCallback(async () => {
    try {
      setWindows(await listMaintenanceWindows(projectId));
      setLoadError(null);
    } catch (error) {
      setLoadError(messageFor(error, 'Could not load maintenance windows.'));
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    // The callback commits state only after the external request settles and is also used by retry.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  async function archive() {
    if (!archiveTarget) return;
    try {
      await archiveMaintenanceWindow(projectId, archiveTarget.id);
      setNotice(`${archiveTarget.name} archived.`);
      setArchiveTarget(null);
      await load();
    } catch (error) {
      setNotice(messageFor(error, 'Could not archive the maintenance window.'));
      setArchiveTarget(null);
    }
  }

  const actions: Array<DataTableAction<MaintenanceWindow>> = [
    {
      id: 'view',
      label: 'View',
      href: (window) => maintenanceWindowHref(projectId, window.id),
    },
    {
      id: 'edit',
      label: 'Edit',
      href: (window) => `/projects/${projectId}/maintenance/${window.id}/edit`,
    },
    {
      id: 'archive',
      label: 'Archive',
      tone: 'danger',
      onSelect: (window) => setArchiveTarget(window),
    },
  ];

  return (
    <AppShell page="maintenance" projectId={projectId}>
      <main id="main-content" data-watchrail-workspace className="w-full min-w-0 pb-16">
        <PageHeader
          title="Maintenance"
          description="Plan operational work without turning off checks or distorting incident and uptime history."
          actions={
            <Link
              href={`/projects/${projectId}/maintenance/new`}
              className={actionClassName({ variant: 'primary' })}
            >
              <PlusIcon />
              Schedule maintenance
            </Link>
          }
        />

        {notice ? (
          <div
            className="mt-5 flex items-start justify-between gap-4 rounded-rail-control border border-rail-border bg-rail-raised px-4 py-3 text-sm text-rail-subtle"
            role="status"
          >
            <span>{notice}</span>
            <button
              type="button"
              className="cursor-pointer border-0 bg-transparent p-0 text-rail-muted hover:text-rail-text"
              onClick={() => setNotice(null)}
              aria-label="Dismiss message"
            >
              <CloseIcon />
            </button>
          </div>
        ) : null}

        <section className="mt-8" aria-labelledby="maintenance-list-title">
          <div className="pb-4">
            <h2 id="maintenance-list-title" className="m-0 text-base font-semibold text-rail-text">
              Scheduled windows
            </h2>
            <p className="mt-1 mb-0 text-sm text-rail-muted">
              {windows.length} configured {windows.length === 1 ? 'window' : 'windows'}
            </p>
          </div>
          <div className="overflow-hidden rounded-rail-panel border border-rail-border bg-rail-surface">
            {loading ? (
              <ListLoading />
            ) : loadError ? (
              <ErrorState message={loadError} onRetry={() => void load()} />
            ) : windows.length === 0 ? (
              <div className="flex min-h-48 flex-col items-start justify-center px-5 py-9">
                <h3 className="m-0 text-sm font-semibold text-rail-text">
                  No maintenance scheduled
                </h3>
                <p className="mt-1.5 mb-4 max-w-xl text-sm leading-6 text-rail-muted">
                  Create a one-time or recurring window and choose exactly how planned work affects
                  incidents, notifications, uptime, and status pages.
                </p>
                <Link
                  href={`/projects/${projectId}/maintenance/new`}
                  className={actionClassName({ variant: 'secondary', size: 'compact' })}
                >
                  Schedule the first window
                </Link>
              </div>
            ) : (
              <DataTable
                rows={windows}
                columns={maintenanceColumns}
                actions={actions}
                getRowKey={(window) => window.id}
                getRowHref={(window) => maintenanceWindowHref(projectId, window.id)}
                getRowLabel={(window) => window.name}
                ariaLabel="Maintenance windows"
                minWidthClassName="min-w-[940px]"
              />
            )}
          </div>
        </section>

        <ConfirmationDialog
          open={archiveTarget !== null}
          title={archiveTarget ? `Archive ${archiveTarget.name}?` : 'Archive maintenance window?'}
          description="Future occurrences will stop applying. Historical versions and the audit trail remain available for accurate uptime reporting."
          confirmLabel="Archive window"
          onCancel={() => setArchiveTarget(null)}
          onConfirm={() => void archive()}
        />
      </main>
    </AppShell>
  );
}

const maintenanceColumns: Array<DataTableColumn<MaintenanceWindow>> = [
  {
    id: 'window',
    header: 'Window',
    cell: (window) => (
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className="truncate font-semibold text-rail-text">{window.name}</span>
          <StatusBadge state={windowState(window)} />
        </div>
        <span className="mt-1 block text-xs text-rail-muted">Version {window.versionNumber}</span>
      </div>
    ),
  },
  {
    id: 'schedule',
    header: 'Schedule',
    cell: (window) => (
      <div className="min-w-0">
        <span className="block text-rail-subtle">{scheduleLabel(window)}</span>
        {window.schedule.type === 'RECURRING' ? (
          <span className="mt-1 block truncate text-xs text-rail-muted">
            {window.schedule.timezone}
          </span>
        ) : null}
      </div>
    ),
  },
  {
    id: 'behavior',
    header: 'Behavior',
    className: 'text-rail-subtle',
    cell: effectsLabel,
  },
  {
    id: 'scope',
    header: 'Scope',
    className: 'whitespace-nowrap text-rail-subtle',
    cell: (window) =>
      window.target.type === 'PROJECT'
        ? 'Entire project'
        : `${window.target.monitorIds.length} ${window.target.monitorIds.length === 1 ? 'monitor' : 'monitors'}`,
  },
];

function windowState(window: MaintenanceWindow): 'Active' | 'Scheduled' | 'Recurring' | 'Ended' {
  if (window.schedule.type === 'RECURRING') return 'Recurring';
  const now = Date.now();
  if (now < Date.parse(window.schedule.startsAt)) return 'Scheduled';
  if (now < Date.parse(window.schedule.endsAt)) return 'Active';
  return 'Ended';
}

function StatusBadge({ state }: { state: ReturnType<typeof windowState> }) {
  const classes =
    state === 'Active'
      ? 'border-rail-warning/35 bg-rail-warning/10 text-rail-warning'
      : state === 'Ended'
        ? 'border-rail-border bg-rail-raised text-rail-muted'
        : 'border-rail-accent/35 bg-rail-accent/10 text-rail-accent';
  return (
    <span className={`rounded-[4px] border px-1.5 py-0.5 text-[11px] font-medium ${classes}`}>
      {state}
    </span>
  );
}

function scheduleLabel(window: MaintenanceWindow) {
  if (window.schedule.type === 'ONE_TIME') {
    return `${dateFormatter.format(new Date(window.schedule.startsAt))} – ${dateFormatter.format(new Date(window.schedule.endsAt))}`;
  }
  const days = window.schedule.daysOfWeek
    .map((day) => ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][day])
    .join(', ');
  return `${days} at ${window.schedule.localTime} · ${window.schedule.durationMinutes} min`;
}

function effectsLabel(window: MaintenanceWindow) {
  const labels = [
    window.effects.suppressNotifications ? 'Notifications' : null,
    window.effects.suppressIncidentCreation ? 'Incidents' : null,
    window.effects.excludeFromUptime ? 'Uptime' : null,
    window.effects.publishToStatusPage ? 'Status page' : null,
  ].filter(Boolean);
  return labels.join(' · ');
}

function ErrorState({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="flex min-h-40 flex-col items-start justify-center gap-3 px-5 py-8">
      <p className="m-0 text-sm text-rail-subtle">{message}</p>
      <Button size="compact" onClick={onRetry}>
        Retry
      </Button>
    </div>
  );
}

function ListLoading() {
  return (
    <div className="animate-pulse divide-y divide-rail-border" role="status">
      {[0, 1, 2].map((row) => (
        <div key={row} className="h-20 bg-rail-raised" />
      ))}
      <span className="sr-only">Loading maintenance windows…</span>
    </div>
  );
}

function PlusIcon() {
  return <Plus className="size-4" strokeWidth={1.75} aria-hidden="true" />;
}

function CloseIcon() {
  return <X className="size-4" strokeWidth={1.75} aria-hidden="true" />;
}

function maintenanceWindowHref(projectId: string, maintenanceWindowId: string): string {
  return `/projects/${projectId}/maintenance/${maintenanceWindowId}`;
}

function messageFor(error: unknown, fallback: string) {
  return error instanceof MaintenanceWindowRequestError ? error.message : fallback;
}
