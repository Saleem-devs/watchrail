'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { AppShell } from '../../components/app-shell';
import { actionClassName, Button } from '../../components/ui/button';
import { ConfirmationDialog } from '../../components/ui/confirmation-dialog';
import { PageHeader } from '../../components/ui/page-header';
import {
  archiveMaintenanceWindow,
  findMaintenanceWindow,
  listMaintenanceMonitors,
  listMaintenanceWindowAuditEvents,
  MaintenanceWindowRequestError,
} from './maintenance-window-api';
import type { MaintenanceMonitor, MaintenanceWindow, MaintenanceWindowAuditEvent } from './types';

const dateTimeFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeStyle: 'short',
});

const dateFormatter = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' });

const auditLabels = {
  CREATED: 'Maintenance window created',
  UPDATED: 'Configuration updated',
  ARCHIVED: 'Maintenance window archived',
} as const;

export function MaintenanceWindowDetailPage({
  projectId,
  maintenanceWindowId,
}: {
  projectId: string;
  maintenanceWindowId: string;
}) {
  const router = useRouter();
  const [maintenanceWindow, setMaintenanceWindow] = useState<MaintenanceWindow | null>(null);
  const [monitors, setMonitors] = useState<MaintenanceMonitor[]>([]);
  const [events, setEvents] = useState<MaintenanceWindowAuditEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [historyLoading, setHistoryLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmArchive, setConfirmArchive] = useState(false);
  const [busy, setBusy] = useState(false);
  const listPath = `/projects/${projectId}/maintenance`;

  const loadHistory = useCallback(async () => {
    setHistoryLoading(true);
    setHistoryError(null);
    try {
      setEvents(await listMaintenanceWindowAuditEvents(projectId, maintenanceWindowId));
    } catch (loadError) {
      setHistoryError(messageFor(loadError, 'Could not load maintenance history.'));
    } finally {
      setHistoryLoading(false);
    }
  }, [maintenanceWindowId, projectId]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [loadedWindow, loadedMonitors] = await Promise.all([
        findMaintenanceWindow(projectId, maintenanceWindowId),
        listMaintenanceMonitors(projectId),
      ]);
      if (loadedWindow.projectId !== projectId) throw new Error('Maintenance window not found.');
      setMaintenanceWindow(loadedWindow);
      setMonitors(loadedMonitors);
      setError(null);
      await loadHistory();
    } catch (loadError) {
      setError(messageFor(loadError, 'Could not load this maintenance window.'));
      setHistoryLoading(false);
    } finally {
      setLoading(false);
    }
  }, [loadHistory, maintenanceWindowId, projectId]);

  useEffect(() => {
    const timeoutId = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timeoutId);
  }, [load]);

  async function archive() {
    if (!maintenanceWindow || busy) return;
    setBusy(true);
    try {
      await archiveMaintenanceWindow(projectId, maintenanceWindow.id);
      router.replace(listPath);
      router.refresh();
    } catch (archiveError) {
      setNotice(messageFor(archiveError, 'Could not archive this maintenance window.'));
      setConfirmArchive(false);
      setBusy(false);
    }
  }

  return (
    <AppShell page="maintenance" projectId={projectId}>
      <main id="main-content" data-watchrail-workspace className="w-full min-w-0 pb-16">
        <PageHeader
          title={maintenanceWindow?.name ?? 'Maintenance window'}
          description={
            maintenanceWindow
              ? `${scheduleTypeLabel(maintenanceWindow)} maintenance window`
              : 'Loading maintenance details…'
          }
          backLink={{ href: listPath, label: 'Back to maintenance' }}
          actions={
            maintenanceWindow && !maintenanceWindow.archivedAt ? (
              <Link
                href={`${listPath}/${maintenanceWindow.id}/edit`}
                className={actionClassName({ variant: 'primary' })}
              >
                Edit window
              </Link>
            ) : null
          }
        />

        {notice ? (
          <div
            className="mt-5 rounded-rail-control border border-rail-border bg-rail-raised px-4 py-3 text-sm text-rail-subtle"
            role="status"
          >
            {notice}
          </div>
        ) : null}

        {loading ? (
          <div
            className="mt-8 grid min-h-56 place-items-center rounded-rail-panel border border-rail-border bg-rail-surface text-sm text-rail-muted"
            role="status"
          >
            Loading maintenance window…
          </div>
        ) : error || !maintenanceWindow ? (
          <div
            className="mt-8 flex min-h-56 flex-col items-start justify-center gap-3 rounded-rail-panel border border-rail-border bg-rail-surface px-5 py-10"
            role="alert"
          >
            <p className="m-0 text-sm text-rail-subtle">
              {error ?? 'Maintenance window not found.'}
            </p>
            <Button size="compact" onClick={() => void load()}>
              Retry
            </Button>
          </div>
        ) : (
          <>
            <MaintenanceOverview window={maintenanceWindow} monitors={monitors} />
            <MaintenanceBehavior window={maintenanceWindow} />
            <MaintenanceHistory
              events={events}
              loading={historyLoading}
              error={historyError}
              onRetry={() => void loadHistory()}
            />
            {!maintenanceWindow.archivedAt ? (
              <section
                className="mt-10 border-t border-rail-border pt-6"
                aria-labelledby="archive-maintenance-title"
              >
                <div className="flex flex-wrap items-center justify-between gap-4">
                  <div>
                    <h2
                      id="archive-maintenance-title"
                      className="m-0 text-sm font-semibold text-rail-text"
                    >
                      Archive maintenance window
                    </h2>
                    <p className="mt-1 mb-0 text-sm text-rail-muted">
                      Stop future occurrences while retaining configuration and history.
                    </p>
                  </div>
                  <Button variant="danger" onClick={() => setConfirmArchive(true)}>
                    Archive window
                  </Button>
                </div>
              </section>
            ) : null}
          </>
        )}

        <ConfirmationDialog
          open={confirmArchive}
          title={
            maintenanceWindow ? `Archive ${maintenanceWindow.name}?` : 'Archive maintenance window?'
          }
          description="Future occurrences will stop applying. Historical versions and the audit trail remain available for accurate uptime reporting."
          confirmLabel={busy ? 'Archiving…' : 'Archive window'}
          onCancel={() => {
            if (!busy) setConfirmArchive(false);
          }}
          onConfirm={() => void archive()}
        />
      </main>
    </AppShell>
  );
}

function MaintenanceOverview({
  window,
  monitors,
}: {
  window: MaintenanceWindow;
  monitors: MaintenanceMonitor[];
}) {
  return (
    <section
      className="mt-8 overflow-hidden rounded-rail-panel border border-rail-border bg-rail-surface"
      aria-labelledby="maintenance-overview-title"
    >
      <div className="border-b border-rail-border px-5 py-4">
        <h2 id="maintenance-overview-title" className="m-0 text-sm font-semibold text-rail-text">
          Maintenance overview
        </h2>
        <p className="mt-1 mb-0 text-xs text-rail-muted">
          Current schedule, scope, and configuration state.
        </p>
      </div>
      <dl className="m-0 grid sm:grid-cols-2 lg:grid-cols-4">
        <Definition label="Status" value={windowState(window)} />
        <Definition label="Schedule type" value={scheduleTypeLabel(window)} />
        <Definition label="Version" value={String(window.versionNumber)} />
        <Definition label="Updated" value={dateTimeFormatter.format(new Date(window.updatedAt))} />
      </dl>
      <div className="grid border-t border-rail-border lg:grid-cols-2">
        <ScheduleDetails window={window} />
        <ScopeDetails window={window} monitors={monitors} />
      </div>
    </section>
  );
}

function ScheduleDetails({ window }: { window: MaintenanceWindow }) {
  return (
    <div className="border-b border-rail-border px-5 py-5 lg:border-r lg:border-b-0">
      <h3 className="m-0 text-xs font-medium text-rail-muted">Schedule</h3>
      {window.schedule.type === 'ONE_TIME' ? (
        <dl className="mt-3 mb-0 grid gap-3 sm:grid-cols-2">
          <CompactDefinition
            label="Starts"
            value={dateTimeFormatter.format(new Date(window.schedule.startsAt))}
          />
          <CompactDefinition
            label="Ends"
            value={dateTimeFormatter.format(new Date(window.schedule.endsAt))}
          />
        </dl>
      ) : (
        <dl className="mt-3 mb-0 grid gap-3 sm:grid-cols-2">
          <CompactDefinition label="Days" value={weekdayLabel(window.schedule.daysOfWeek)} />
          <CompactDefinition label="Local time" value={window.schedule.localTime} />
          <CompactDefinition
            label="Duration"
            value={`${window.schedule.durationMinutes} minutes`}
          />
          <CompactDefinition label="Time zone" value={window.schedule.timezone} />
          <CompactDefinition
            label="Starts on"
            value={formatCalendarDate(window.schedule.startsOn)}
          />
          <CompactDefinition
            label="Ends on"
            value={
              window.schedule.endsOn ? formatCalendarDate(window.schedule.endsOn) : 'No end date'
            }
          />
        </dl>
      )}
    </div>
  );
}

function ScopeDetails({
  window,
  monitors,
}: {
  window: MaintenanceWindow;
  monitors: MaintenanceMonitor[];
}) {
  const monitorNames = new Map(monitors.map((monitor) => [monitor.id, monitor.name]));
  const selectedMonitors =
    window.target.type === 'MONITORS'
      ? window.target.monitorIds.map((id) => monitorNames.get(id) ?? 'Monitor unavailable')
      : [];
  return (
    <div className="px-5 py-5">
      <h3 className="m-0 text-xs font-medium text-rail-muted">Monitor scope</h3>
      <p className="mt-3 mb-0 text-sm font-medium text-rail-text">
        {window.target.type === 'PROJECT' ? 'Entire project' : 'Selected monitors'}
      </p>
      <p className="mt-1 mb-0 text-sm leading-6 text-rail-muted">
        {window.target.type === 'PROJECT'
          ? 'Includes monitors added to this project later.'
          : selectedMonitors.join(', ')}
      </p>
    </div>
  );
}

function MaintenanceBehavior({ window }: { window: MaintenanceWindow }) {
  return (
    <section
      className="mt-8 overflow-hidden rounded-rail-panel border border-rail-border bg-rail-surface"
      aria-labelledby="maintenance-behavior-title"
    >
      <div className="border-b border-rail-border px-5 py-4">
        <h2 id="maintenance-behavior-title" className="m-0 text-sm font-semibold text-rail-text">
          Behavior
        </h2>
        <p className="mt-1 mb-0 text-xs text-rail-muted">
          How Watchrail treats monitoring evidence while this window is active.
        </p>
      </div>
      <dl className="m-0 grid sm:grid-cols-2 lg:grid-cols-4">
        <Definition
          label="Notifications"
          value={window.effects.suppressNotifications ? 'Suppressed' : 'Delivered normally'}
        />
        <Definition
          label="Incident creation"
          value={window.effects.suppressIncidentCreation ? 'Suppressed' : 'Active'}
        />
        <Definition
          label="Uptime"
          value={window.effects.excludeFromUptime ? 'Excluded' : 'Included'}
        />
        <Definition
          label="Status page"
          value={window.effects.publishToStatusPage ? 'Published' : 'Not published'}
        />
      </dl>
    </section>
  );
}

function MaintenanceHistory({
  events,
  loading,
  error,
  onRetry,
}: {
  events: MaintenanceWindowAuditEvent[];
  loading: boolean;
  error: string | null;
  onRetry: () => void;
}) {
  return (
    <section className="mt-8" aria-labelledby="maintenance-history-title">
      <div className="pb-4">
        <h2 id="maintenance-history-title" className="m-0 text-base font-semibold text-rail-text">
          Maintenance history
        </h2>
        <p className="mt-1 mb-0 text-sm text-rail-muted">
          Immutable configuration and archive events.
        </p>
      </div>
      <div className="overflow-hidden rounded-rail-panel border border-rail-border bg-rail-surface">
        {loading ? (
          <p className="m-0 px-5 py-5 text-sm text-rail-muted" role="status">
            Loading maintenance history…
          </p>
        ) : error ? (
          <div className="flex items-center justify-between gap-4 px-5 py-5" role="alert">
            <p className="m-0 text-sm text-rail-subtle">{error}</p>
            <Button size="compact" onClick={onRetry}>
              Retry
            </Button>
          </div>
        ) : events.length ? (
          <div className="divide-y divide-rail-border">
            {events.map((event) => (
              <div
                key={event.id}
                className="flex flex-wrap items-center justify-between gap-4 px-5 py-4"
              >
                <div>
                  <p className="m-0 text-sm font-medium text-rail-text">
                    {auditLabels[event.action]}
                  </p>
                  <p className="mt-1 mb-0 text-xs text-rail-muted">Version {event.versionNumber}</p>
                </div>
                <time className="text-xs text-rail-muted tabular-nums" dateTime={event.occurredAt}>
                  {dateTimeFormatter.format(new Date(event.occurredAt))}
                </time>
              </div>
            ))}
          </div>
        ) : (
          <p className="m-0 px-5 py-5 text-sm text-rail-muted">No history is available.</p>
        )}
      </div>
    </section>
  );
}

function Definition({ label, value }: { label: string; value: string }) {
  return (
    <div className="border-b border-rail-border px-5 py-4 last:border-b-0 sm:border-r sm:[&:nth-child(2n)]:border-r-0 lg:border-b-0 lg:[&:nth-child(2n)]:border-r lg:last:border-r-0">
      <dt className="text-xs text-rail-muted">{label}</dt>
      <dd className="mt-1.5 mb-0 text-sm font-medium text-rail-text">{value}</dd>
    </div>
  );
}

function CompactDefinition({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs text-rail-muted">{label}</dt>
      <dd className="mt-1 mb-0 text-sm text-rail-text">{value}</dd>
    </div>
  );
}

function windowState(window: MaintenanceWindow): string {
  if (window.archivedAt) return 'Archived';
  if (window.schedule.type === 'RECURRING') return 'Recurring';
  const now = Date.now();
  if (now < Date.parse(window.schedule.startsAt)) return 'Scheduled';
  if (now < Date.parse(window.schedule.endsAt)) return 'Active';
  return 'Ended';
}

function scheduleTypeLabel(window: MaintenanceWindow): string {
  return window.schedule.type === 'RECURRING' ? 'Recurring' : 'One-time';
}

function weekdayLabel(daysOfWeek: number[]): string {
  const names = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  return daysOfWeek.map((day) => names[day]).join(', ');
}

function formatCalendarDate(value: string): string {
  const [year = 0, month = 1, day = 1] = value.split('-').map(Number);
  return dateFormatter.format(new Date(year, month - 1, day));
}

function messageFor(error: unknown, fallback: string): string {
  return error instanceof MaintenanceWindowRequestError ? error.message : fallback;
}
