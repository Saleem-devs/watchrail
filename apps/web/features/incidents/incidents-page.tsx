'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { AppShell } from '../../components/app-shell';
import { Button, actionClassName } from '../../components/ui/button';
import { PageHeader } from '../../components/ui/page-header';
import { TablePagination } from '../../components/ui/table-pagination';
import { IncidentFiltersDialog } from './incident-filters-dialog';
import {
  acknowledgeIncident,
  IncidentRequestError,
  resolveIncident,
  silenceIncident,
  unsilenceIncident,
} from './incident-api';
import { IncidentActionDialog, type IncidentDialogAction } from './incident-action-dialog';
import { IncidentTable } from './incident-table';
import type { IncidentStatusFilter, WorkspaceIncident, WorkspaceIncidentPage } from './types';

export function IncidentsPage({
  projectId,
  initialStatus,
  initialPage,
  initialLimit,
}: {
  projectId?: string | undefined;
  initialStatus: IncidentStatusFilter;
  initialPage: number;
  initialLimit: number;
}) {
  const projectBase = projectId ? `/projects/${projectId}` : '';
  const [status, setStatus] = useState(initialStatus);
  const [page, setPage] = useState<WorkspaceIncidentPage>({
    items: [],
    number: initialPage,
    limit: initialLimit,
    total: 0,
    totalPages: 1,
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [actionTarget, setActionTarget] = useState<WorkspaceIncident | null>(null);
  const [dialogAction, setDialogAction] = useState<IncidentDialogAction | null>(null);
  const [actionBusy, setActionBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const pathFor = useCallback(
    (nextStatus: IncidentStatusFilter, number: number, limit: number) => {
      const query = new URLSearchParams({
        status: nextStatus,
        page: String(number),
        limit: String(limit),
      });
      return `${projectBase}/incidents?${query}`;
    },
    [projectBase],
  );

  const load = useCallback(
    async (nextStatus: IncidentStatusFilter, number: number, limit: number) => {
      setLoading(true);
      setError(undefined);
      try {
        const query = new URLSearchParams({ page: String(number), limit: String(limit) });
        if (projectId) query.set('projectId', projectId);
        if (nextStatus !== 'all') query.set('status', nextStatus.toUpperCase());
        const response = await fetch(`/api/incidents?${query}`, {
          headers: { Accept: 'application/json' },
        });
        if (!response.ok) throw new Error();
        const body = (await response.json()) as {
          data: WorkspaceIncident[];
          page: Omit<WorkspaceIncidentPage, 'items'>;
        };
        setPage({ items: body.data, ...body.page });
      } catch {
        setError(
          'Watchrail could not load incidents. Check that the API and database are running.',
        );
      } finally {
        setLoading(false);
      }
    },
    [projectId],
  );

  useEffect(() => {
    const timer = window.setTimeout(() => void load(initialStatus, initialPage, initialLimit), 0);
    return () => window.clearTimeout(timer);
  }, [initialLimit, initialPage, initialStatus, load]);

  function navigate(nextStatus: IncidentStatusFilter, number: number, limit: number) {
    setStatus(nextStatus);
    window.history.pushState(null, '', pathFor(nextStatus, number, limit));
    void load(nextStatus, number, limit);
  }

  useEffect(() => {
    const restore = () => {
      const query = new URLSearchParams(window.location.search);
      const restoredStatus = query.get('status');
      const nextStatus: IncidentStatusFilter =
        restoredStatus === 'open' || restoredStatus === 'resolved' ? restoredStatus : 'all';
      const number = Math.max(1, Number(query.get('page')) || 1);
      const requestedLimit = Number(query.get('limit'));
      const limit = [10, 25, 50, 100].includes(requestedLimit) ? requestedLimit : 25;
      setStatus(nextStatus);
      void load(nextStatus, number, limit);
    };
    window.addEventListener('popstate', restore);
    return () => window.removeEventListener('popstate', restore);
  }, [load]);

  const origin = pathFor(status, page.number, page.limit);
  const closeDialog = useCallback(() => {
    if (actionBusy) return;
    setActionTarget(null);
    setDialogAction(null);
    setActionError(null);
  }, [actionBusy]);

  async function refreshAfterAction(message: string) {
    setNotice(message);
    await load(status, page.number, page.limit);
  }

  async function acknowledge(incident: WorkspaceIncident) {
    try {
      await acknowledgeIncident(incident.id);
      await refreshAfterAction(`${incident.monitorName} incident acknowledged.`);
    } catch (actionFailure) {
      setNotice(actionMessage(actionFailure, 'Could not acknowledge the incident.'));
    }
  }

  async function unsilence(incident: WorkspaceIncident) {
    try {
      await unsilenceIncident(incident.id);
      await refreshAfterAction(`Notifications resumed for ${incident.monitorName}.`);
    } catch (actionFailure) {
      setNotice(actionMessage(actionFailure, 'Could not resume incident notifications.'));
    }
  }

  async function confirmAction(value: { until?: Date; note?: string | null }) {
    if (!actionTarget || !dialogAction) return;
    setActionBusy(true);
    setActionError(null);
    try {
      if (dialogAction === 'silence') {
        if (!value.until) throw new Error('Silence expiry is missing.');
        await silenceIncident(actionTarget.id, value.until);
        await refreshAfterAction(`Notifications silenced for ${actionTarget.monitorName}.`);
      } else {
        await resolveIncident(actionTarget.id, value.note ?? null);
        await refreshAfterAction(`${actionTarget.monitorName} incident resolved.`);
      }
      setActionTarget(null);
      setDialogAction(null);
    } catch (actionFailure) {
      setActionError(actionMessage(actionFailure, 'Could not update the incident.'));
    } finally {
      setActionBusy(false);
    }
  }

  return (
    <AppShell page="incidents" projectId={projectId}>
      <main id="main-content" data-watchrail-workspace className="w-full min-w-0 pb-16">
        <PageHeader
          title="Incidents"
          description="Investigate active service failures and review resolved interruptions in this project."
          actions={
            <IncidentFiltersDialog
              status={status}
              onApply={(next) => navigate(next, 1, page.limit)}
            />
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
        <section className="mt-6 overflow-hidden rounded-rail-panel border border-rail-border bg-rail-surface">
          {loading ? (
            <div className="grid min-h-52 place-items-center px-5 py-12" role="status">
              <p className="m-0 text-sm text-rail-muted">Loading workspace incidents…</p>
            </div>
          ) : error ? (
            <div className="px-5 py-12 text-center" role="alert">
              <h2 className="m-0 text-base font-medium text-rail-text">
                Incidents are unavailable
              </h2>
              <p className="mx-auto mt-2 mb-4 max-w-md text-sm leading-6 text-rail-subtle">
                {error}
              </p>
              <Button onClick={() => void load(status, page.number, page.limit)}>Try again</Button>
            </div>
          ) : page.items.length === 0 ? (
            <div className="px-5 py-12 text-center">
              <h2 className="m-0 text-base font-medium text-rail-text">
                {status === 'open' ? 'No open incidents' : 'No incidents found'}
              </h2>
              <p className="mx-auto mt-2 mb-4 max-w-md text-sm leading-6 text-rail-subtle">
                {status === 'open'
                  ? 'Every monitored service is clear of an active incident.'
                  : 'Incident history will appear here when Watchrail confirms a service failure.'}
              </p>
              <Link
                href={`${projectBase}/monitors?page=1&limit=25`}
                className={actionClassName({ size: 'compact' })}
              >
                View monitors
              </Link>
            </div>
          ) : (
            <>
              <IncidentTable
                incidents={page.items}
                origin={origin}
                projectId={projectId}
                onAcknowledge={acknowledge}
                onSilence={(incident) => {
                  setActionTarget(incident);
                  setDialogAction('silence');
                }}
                onUnsilence={unsilence}
                onResolve={(incident) => {
                  setActionTarget(incident);
                  setDialogAction('resolve');
                }}
              />
              <TablePagination
                page={page}
                label="incidents"
                onPageChange={(number) => navigate(status, number, page.limit)}
                onLimitChange={(limit) => navigate(status, 1, limit)}
              />
            </>
          )}
        </section>
        <IncidentActionDialog
          key={`${dialogAction ?? 'closed'}:${actionTarget?.id ?? ''}`}
          action={dialogAction}
          incident={actionTarget}
          busy={actionBusy}
          error={actionError}
          onCancel={closeDialog}
          onConfirm={(value) => void confirmAction(value)}
        />
      </main>
    </AppShell>
  );
}

function actionMessage(error: unknown, fallback: string): string {
  return error instanceof IncidentRequestError ? error.message : fallback;
}
