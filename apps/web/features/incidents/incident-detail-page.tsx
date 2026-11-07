'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { AppShell } from '../../components/app-shell';
import { actionClassName, Button } from '../../components/ui/button';
import { PageHeader } from '../../components/ui/page-header';
import { monitorDetailHref } from '../../lib/navigation-origin';
import { IncidentActionDialog, type IncidentDialogAction } from './incident-action-dialog';
import {
  acknowledgeIncident,
  findIncident,
  IncidentRequestError,
  listIncidentActions,
  resolveIncident,
  silenceIncident,
  unsilenceIncident,
} from './incident-api';
import type { IncidentActionEvent, WorkspaceIncidentDetail } from './types';

const dateTimeFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeStyle: 'short',
});

export function IncidentDetailPage({
  projectId,
  incidentId,
}: {
  projectId: string;
  incidentId: string;
}) {
  const [incident, setIncident] = useState<WorkspaceIncidentDetail | null>(null);
  const [events, setEvents] = useState<IncidentActionEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [dialogAction, setDialogAction] = useState<IncidentDialogAction | null>(null);
  const [actionBusy, setActionBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [loadedIncident, loadedEvents] = await Promise.all([
        findIncident(incidentId),
        listIncidentActions(incidentId),
      ]);
      if (loadedIncident.projectId !== projectId) throw new Error('Incident not found.');
      setIncident(loadedIncident);
      setEvents(loadedEvents);
      setError(null);
    } catch (loadError) {
      setError(actionMessage(loadError, 'Could not load this incident.'));
    } finally {
      setLoading(false);
    }
  }, [incidentId, projectId]);

  useEffect(() => {
    const timeoutId = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timeoutId);
  }, [load]);

  const closeDialog = useCallback(() => {
    if (actionBusy) return;
    setDialogAction(null);
    setActionError(null);
  }, [actionBusy]);

  async function runAcknowledge() {
    if (!incident) return;
    setActionBusy(true);
    try {
      await acknowledgeIncident(incident.id);
      setNotice('Incident acknowledged.');
      await load();
    } catch (actionFailure) {
      setNotice(actionMessage(actionFailure, 'Could not acknowledge the incident.'));
    } finally {
      setActionBusy(false);
    }
  }

  async function runUnsilence() {
    if (!incident) return;
    setActionBusy(true);
    try {
      await unsilenceIncident(incident.id);
      setNotice('Incident notifications resumed.');
      await load();
    } catch (actionFailure) {
      setNotice(actionMessage(actionFailure, 'Could not resume incident notifications.'));
    } finally {
      setActionBusy(false);
    }
  }

  async function confirmAction(value: { until?: Date; note?: string | null }) {
    if (!incident || !dialogAction) return;
    setActionBusy(true);
    setActionError(null);
    try {
      if (dialogAction === 'silence') {
        if (!value.until) throw new Error('Silence expiry is missing.');
        await silenceIncident(incident.id, value.until);
        setNotice('Incident notifications silenced.');
      } else {
        await resolveIncident(incident.id, value.note ?? null);
        setNotice('Incident resolved. Monitor health is still determined by checks.');
      }
      setDialogAction(null);
      await load();
    } catch (actionFailure) {
      setActionError(actionMessage(actionFailure, 'Could not update the incident.'));
    } finally {
      setActionBusy(false);
    }
  }

  const origin = `/projects/${projectId}/incidents/${incidentId}`;
  return (
    <AppShell page="incidents" projectId={projectId}>
      <main id="main-content" data-watchrail-workspace className="w-full min-w-0 pb-16">
        <PageHeader
          title={incident?.monitorName ?? 'Incident'}
          description={
            incident
              ? `${impactLabel(incident)} · started ${formatDateTime(incident.startedAt)}`
              : 'Loading incident details…'
          }
          backLink={{ href: `/projects/${projectId}/incidents`, label: 'Back to incidents' }}
          actions={
            incident ? (
              <>
                <Link
                  href={monitorDetailHref(incident.monitorId, origin, projectId)}
                  className={actionClassName({ variant: 'secondary' })}
                >
                  View monitor
                </Link>
                {incident.status === 'OPEN' && !incident.acknowledgedAt ? (
                  <Button disabled={actionBusy} onClick={() => void runAcknowledge()}>
                    {actionBusy ? 'Updating…' : 'Acknowledge'}
                  </Button>
                ) : null}
                {incident.status === 'OPEN' ? (
                  incident.notificationsSilenced ? (
                    <Button disabled={actionBusy} onClick={() => void runUnsilence()}>
                      Resume notifications
                    </Button>
                  ) : (
                    <Button disabled={actionBusy} onClick={() => setDialogAction('silence')}>
                      Silence this incident
                    </Button>
                  )
                ) : null}
                {incident.status === 'OPEN' ? (
                  <Button
                    variant="danger"
                    disabled={actionBusy}
                    onClick={() => setDialogAction('resolve')}
                  >
                    Resolve incident
                  </Button>
                ) : null}
              </>
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
            Loading incident…
          </div>
        ) : error || !incident ? (
          <div
            className="mt-8 flex min-h-56 flex-col items-start justify-center gap-3 rounded-rail-panel border border-rail-border bg-rail-surface px-5 py-10"
            role="alert"
          >
            <p className="m-0 text-sm text-rail-subtle">{error ?? 'Incident not found.'}</p>
            <Button size="compact" onClick={() => void load()}>
              Retry
            </Button>
          </div>
        ) : (
          <>
            <IncidentOverview incident={incident} />
            <IncidentTimeline incident={incident} events={events} />
          </>
        )}

        <IncidentActionDialog
          key={`${dialogAction ?? 'closed'}:${incident?.id ?? ''}`}
          action={dialogAction}
          incident={incident}
          busy={actionBusy}
          error={actionError}
          onCancel={closeDialog}
          onConfirm={(value) => void confirmAction(value)}
        />
      </main>
    </AppShell>
  );
}

function IncidentOverview({ incident }: { incident: WorkspaceIncidentDetail }) {
  const duration = formatDuration(incident.startedAt, incident.resolvedAt);
  return (
    <section
      className="mt-8 overflow-hidden rounded-rail-panel border border-rail-border bg-rail-surface"
      aria-labelledby="incident-overview-title"
    >
      <div className="border-b border-rail-border px-5 py-4">
        <h2 id="incident-overview-title" className="m-0 text-sm font-semibold text-rail-text">
          Incident overview
        </h2>
        <p className="mt-1 mb-0 text-xs text-rail-muted">
          Current operator state and authoritative monitoring evidence.
        </p>
      </div>
      <dl className="m-0 grid sm:grid-cols-2 xl:grid-cols-4">
        <Detail
          label="Status"
          value={incident.status === 'OPEN' ? 'Open' : 'Resolved'}
          {...(incident.status === 'OPEN' ? { tone: 'danger' as const } : {})}
        />
        <Detail label="Impact" value={impactLabel(incident)} />
        <Detail label="Started" value={formatDateTime(incident.startedAt)} />
        <Detail label="Duration" value={duration} />
        <Detail
          label="Acknowledgement"
          value={
            incident.acknowledgedAt
              ? `Acknowledged ${formatDateTime(incident.acknowledgedAt)}`
              : 'Unacknowledged'
          }
        />
        <Detail
          label="Incident notifications"
          value={
            incident.notificationsSilenced && incident.silencedUntil
              ? `Silenced until ${formatDateTime(incident.silencedUntil)}`
              : 'Active'
          }
        />
        <Detail
          label="Resolution"
          value={
            incident.resolvedByActorId
              ? 'Resolved manually'
              : incident.resolvedAt
                ? 'Recovered automatically'
                : 'Awaiting recovery'
          }
        />
        <Detail label="Incident ID" value={incident.id} mono />
      </dl>
      {incident.resolutionNote ? (
        <div className="border-t border-rail-border px-5 py-4">
          <h3 className="m-0 text-xs font-medium text-rail-muted">Resolution note</h3>
          <p className="mt-2 mb-0 text-sm leading-6 text-rail-subtle">{incident.resolutionNote}</p>
        </div>
      ) : null}
    </section>
  );
}

function Detail({
  label,
  value,
  tone,
  mono = false,
}: {
  label: string;
  value: string;
  tone?: 'danger';
  mono?: boolean;
}) {
  return (
    <div className="border-b border-rail-border px-5 py-4 sm:border-r sm:[&:nth-child(2n)]:border-r-0 xl:border-r xl:border-b-0 xl:[&:nth-child(4n)]:border-r-0">
      <dt className="text-xs text-rail-muted">{label}</dt>
      <dd
        className={`mt-1.5 mb-0 truncate text-sm font-medium ${tone === 'danger' ? 'text-rail-danger' : 'text-rail-text'} ${mono ? 'font-mono text-xs' : ''}`}
        title={value}
      >
        {value}
      </dd>
    </div>
  );
}

function IncidentTimeline({
  incident,
  events,
}: {
  incident: WorkspaceIncidentDetail;
  events: IncidentActionEvent[];
}) {
  const entries = [
    {
      id: 'opened',
      title: 'Incident opened',
      detail: 'Watchrail confirmed the failure threshold and opened this incident.',
      occurredAt: incident.openedAt,
    },
    ...events.map((event) => ({
      id: event.id,
      title: actionTitle(event),
      detail: actionDetail(event),
      occurredAt: event.occurredAt,
    })),
    ...(incident.resolvedAt && !incident.resolvedByActorId
      ? [
          {
            id: 'resolved',
            title: 'Monitor recovered',
            detail: 'An authoritative check returned the monitor to a healthy state.',
            occurredAt: incident.resolvedAt,
          },
        ]
      : []),
  ].sort(
    (left, right) => new Date(left.occurredAt).getTime() - new Date(right.occurredAt).getTime(),
  );
  return (
    <section className="mt-8" aria-labelledby="incident-timeline-title">
      <div className="pb-4">
        <h2 id="incident-timeline-title" className="m-0 text-base font-semibold text-rail-text">
          Incident history
        </h2>
        <p className="mt-1 mb-0 text-sm text-rail-muted">
          Monitoring transitions and operator actions in chronological order.
        </p>
      </div>
      <ol className="m-0 list-none overflow-hidden rounded-rail-panel border border-rail-border bg-rail-surface p-0">
        {entries.map((entry) => (
          <li
            key={entry.id}
            className="grid gap-1 border-b border-rail-border px-5 py-4 last:border-b-0 sm:grid-cols-[minmax(12rem,1fr)_minmax(11rem,auto)] sm:gap-6"
          >
            <div>
              <p className="m-0 text-sm font-medium text-rail-text">{entry.title}</p>
              <p className="mt-1 mb-0 text-sm leading-6 text-rail-muted">{entry.detail}</p>
            </div>
            <time className="text-xs text-rail-muted sm:text-right" dateTime={entry.occurredAt}>
              {formatDateTime(entry.occurredAt)}
            </time>
          </li>
        ))}
      </ol>
    </section>
  );
}

function actionTitle(event: IncidentActionEvent): string {
  if (event.action === 'ACKNOWLEDGED') return 'Incident acknowledged';
  if (event.action === 'SILENCED') return 'Notifications silenced';
  if (event.action === 'UNSILENCED') return 'Notifications resumed';
  return 'Incident resolved manually';
}

function actionDetail(event: IncidentActionEvent): string {
  const actor = `Operator ${event.actorId.slice(0, 8)}`;
  if (event.action === 'SILENCED' && event.silenceUntil) {
    return `${actor} paused notifications until ${formatDateTime(event.silenceUntil)}.`;
  }
  if (event.action === 'MANUALLY_RESOLVED') {
    return event.note ? `${actor}: ${event.note}` : `${actor} closed the incident.`;
  }
  return `${actor} ${event.action === 'ACKNOWLEDGED' ? 'took ownership of the response.' : 'restored notification delivery.'}`;
}

function impactLabel(incident: WorkspaceIncidentDetail): string {
  if (incident.severity === 'DOWN') return 'Unavailable';
  if (incident.severity === 'DEGRADED') return 'Degraded';
  return 'Availability failure';
}

function formatDateTime(value: string): string {
  return dateTimeFormatter.format(new Date(value));
}

function formatDuration(start: string, end: string | null): string {
  const durationMs = Math.max(
    0,
    (end ? new Date(end) : new Date()).getTime() - new Date(start).getTime(),
  );
  const minutes = Math.floor(durationMs / 60_000);
  if (minutes < 1) return '< 1 min';
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  if (hours < 24) return remainingMinutes ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  const remainingHours = hours % 24;
  return remainingHours ? `${days}d ${remainingHours}h` : `${days}d`;
}

function actionMessage(error: unknown, fallback: string): string {
  return error instanceof IncidentRequestError ? error.message : fallback;
}
