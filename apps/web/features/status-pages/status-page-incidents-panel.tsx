'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { actionClassName, Button } from '../../components/ui/button';
import { loadStatusPageIncidents } from './status-page-api';
import type { WorkspaceStatusPageIncident } from './types';

const formatter = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

export function StatusPageIncidentsPanel({
  projectBase,
  statusPageId,
}: {
  projectBase: string;
  statusPageId: string;
}) {
  const [incidents, setIncidents] = useState<WorkspaceStatusPageIncident[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const base = `${projectBase}/status-pages/${statusPageId}/incidents`;
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

  return (
    <section
      className="overflow-hidden rounded-rail-panel border border-rail-border bg-rail-surface xl:col-span-2"
      aria-labelledby="status-page-incidents"
    >
      <div className="flex flex-wrap items-start justify-between gap-4 border-b border-rail-border p-5 sm:p-6">
        <div>
          <h2 id="status-page-incidents" className="m-0 text-base font-medium text-rail-text">
            Incident communication
          </h2>
          <p className="mt-1 mb-0 text-sm text-rail-subtle">
            Publish operator updates without changing monitor health or uptime.
          </p>
        </div>
        <Link href={`${base}/new`} className={actionClassName({ variant: 'secondary' })}>
          Create incident
        </Link>
      </div>

      {loading ? (
        <p className="m-0 px-5 py-8 text-sm text-rail-muted" role="status">
          Loading incident communication…
        </p>
      ) : error ? (
        <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-6" role="alert">
          <p className="m-0 text-sm text-rail-subtle">{error}</p>
          <Button size="compact" onClick={() => void load()}>
            Try again
          </Button>
        </div>
      ) : incidents.length === 0 ? (
        <div className="px-5 py-8 sm:px-6">
          <h3 className="m-0 text-sm font-medium text-rail-text">No manual incidents</h3>
          <p className="mt-1 mb-0 max-w-xl text-sm leading-6 text-rail-subtle">
            Create one when customers need an explanation that is independent of automated monitor
            incidents.
          </p>
        </div>
      ) : (
        <ol className="m-0 list-none divide-y divide-rail-border p-0">
          {incidents.slice(0, 6).map((incident) => (
            <li key={incident.id}>
              <Link
                href={`${base}/${incident.id}`}
                className="grid min-h-20 gap-2 px-5 py-4 text-rail-text no-underline hover:bg-rail-hover focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-rail-accent sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center sm:px-6"
              >
                <span className="min-w-0">
                  <span className="flex items-center gap-2">
                    <span
                      className={`size-2 shrink-0 rounded-full ${incident.state === 'RESOLVED' ? 'bg-rail-success' : incident.impact === 'DOWN' ? 'bg-rail-danger' : 'bg-rail-warning'}`}
                      aria-hidden="true"
                    />
                    <span className="truncate text-sm font-medium">{incident.title}</span>
                  </span>
                  <span className="mt-1 block truncate text-xs text-rail-muted">
                    {stateLabel(incident.state)} ·{' '}
                    {incident.components.map(({ displayName }) => displayName).join(', ')}
                  </span>
                </span>
                <time
                  className="text-xs tabular-nums text-rail-muted"
                  dateTime={incident.updatedAt}
                >
                  {formatter.format(new Date(incident.updatedAt))}
                </time>
              </Link>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

export function stateLabel(state: WorkspaceStatusPageIncident['state']): string {
  return {
    INVESTIGATING: 'Investigating',
    IDENTIFIED: 'Identified',
    MONITORING: 'Monitoring',
    RESOLVED: 'Resolved',
  }[state];
}
