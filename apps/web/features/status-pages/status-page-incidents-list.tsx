'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { AppShell } from '../../components/app-shell';
import { actionClassName, Button } from '../../components/ui/button';
import { PageHeader } from '../../components/ui/page-header';
import { loadStatusPageIncidents } from './status-page-api';
import { orderStatusPageIncidents, StatusPageIncidentRows } from './status-page-incidents-panel';
import type { WorkspaceStatusPageIncident } from './types';

export function StatusPageIncidentsList({
  projectId,
  statusPageId,
}: {
  projectId: string;
  statusPageId: string;
}) {
  const pageBase = `/projects/${projectId}/status-pages/${statusPageId}`;
  const incidentBase = `${pageBase}/incidents`;
  const [incidents, setIncidents] = useState<WorkspaceStatusPageIncident[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();

  const load = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try {
      setIncidents(await loadStatusPageIncidents(statusPageId));
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Could not load incidents.');
    } finally {
      setLoading(false);
    }
  }, [statusPageId]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  const ordered = orderStatusPageIncidents(incidents);
  const active = ordered.filter(({ state }) => state !== 'RESOLVED');
  const resolved = ordered.filter(({ state }) => state === 'RESOLVED');

  return (
    <AppShell page="status-pages" projectId={projectId}>
      <main id="main-content" data-watchrail-workspace className="w-full min-w-0 pb-16">
        <PageHeader
          title="Incident communication"
          description={
            loading
              ? 'Loading manual incidents…'
              : `${active.length} active · ${resolved.length} resolved`
          }
          backLink={{ href: pageBase, label: 'Back to status page' }}
          actions={
            <Link href={`${incidentBase}/new`} className={actionClassName({ variant: 'primary' })}>
              Create incident
            </Link>
          }
        />

        {loading ? (
          <div className="grid min-h-64 place-items-center text-sm text-rail-muted" role="status">
            Loading incident communication…
          </div>
        ) : error ? (
          <div
            className="mt-6 flex flex-wrap items-center justify-between gap-3 rounded-rail-panel border border-rail-border bg-rail-surface p-5"
            role="alert"
          >
            <p className="m-0 text-sm text-rail-subtle">{error}</p>
            <Button size="compact" onClick={() => void load()}>
              Try again
            </Button>
          </div>
        ) : incidents.length === 0 ? (
          <section className="mt-6 rounded-rail-panel border border-rail-border bg-rail-surface p-6">
            <h2 className="m-0 text-base font-medium text-rail-text">No manual incidents</h2>
            <p className="mt-1 mb-0 max-w-xl text-sm leading-6 text-rail-subtle">
              Create one when customers need an explanation that is independent of automated monitor
              incidents.
            </p>
          </section>
        ) : (
          <div className="mt-6 grid gap-6">
            <IncidentCollection
              title="Active incidents"
              description="Incidents that can still receive customer updates."
              empty="No active incidents."
              incidents={active}
              base={incidentBase}
            />
            <IncidentCollection
              title="Resolved history"
              description="Completed incident communication retained for review."
              empty="No resolved incidents."
              incidents={resolved}
              base={incidentBase}
            />
          </div>
        )}
      </main>
    </AppShell>
  );
}

function IncidentCollection({
  title,
  description,
  empty,
  incidents,
  base,
}: {
  title: string;
  description: string;
  empty: string;
  incidents: WorkspaceStatusPageIncident[];
  base: string;
}) {
  const headingId = `status-page-${title.toLowerCase().replaceAll(' ', '-')}`;
  return (
    <section
      data-ui="status-page-incident-collection"
      className="overflow-hidden rounded-rail-panel border border-rail-border bg-rail-surface"
      aria-labelledby={headingId}
    >
      <div className="border-b border-rail-border p-5 sm:p-6">
        <div className="flex items-baseline justify-between gap-4">
          <h2 id={headingId} className="m-0 text-base font-medium text-rail-text">
            {title}
          </h2>
          <span className="shrink-0 text-xs tabular-nums text-rail-muted">{incidents.length}</span>
        </div>
        <p className="mt-1 mb-0 text-sm text-rail-subtle">{description}</p>
      </div>
      {incidents.length > 0 ? (
        <StatusPageIncidentRows incidents={incidents} base={base} />
      ) : (
        <p className="m-0 px-5 py-6 text-sm text-rail-muted sm:px-6">{empty}</p>
      )}
    </section>
  );
}
