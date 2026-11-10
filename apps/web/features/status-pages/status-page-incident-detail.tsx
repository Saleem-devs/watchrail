'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { AppShell } from '../../components/app-shell';
import { Button } from '../../components/ui/button';
import { Select, Textarea } from '../../components/ui/form-control';
import { PageHeader } from '../../components/ui/page-header';
import { apiErrorMessage, loadStatusPageIncident } from './status-page-api';
import { stateLabel } from './status-page-incidents-panel';
import type {
  StatusPageApiError,
  StatusPageIncidentState,
  WorkspaceStatusPageIncident,
} from './types';

const formatter = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

export function StatusPageIncidentDetail({
  projectId,
  statusPageId,
  incidentId,
}: {
  projectId: string;
  statusPageId: string;
  incidentId: string;
}) {
  const base = `/projects/${projectId}/status-pages/${statusPageId}`;
  const [incident, setIncident] = useState<WorkspaceStatusPageIncident>();
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string>();
  const [state, setState] = useState<StatusPageIncidentState>('INVESTIGATING');
  const [message, setMessage] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try {
      const loadedIncident = await loadStatusPageIncident(statusPageId, incidentId);
      setIncident(loadedIncident);
      const options = nextStates(loadedIncident.state);
      if (options[0]) setState(options[0]);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Could not load incident.');
    } finally {
      setLoading(false);
    }
  }, [incidentId, statusPageId]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!incident) return;
    setSubmitting(true);
    setError(undefined);
    try {
      const response = await fetch(
        `/api/status-pages/${statusPageId}/incidents/${incidentId}/updates`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({ state, message }),
        },
      );
      const body = (await response.json()) as {
        data?: WorkspaceStatusPageIncident;
      } & StatusPageApiError;
      if (!response.ok || !body.data)
        throw new Error(apiErrorMessage(body, 'Could not publish update.'));
      setIncident(body.data);
      setMessage('');
      const options = nextStates(body.data.state);
      if (options[0]) setState(options[0]);
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : 'Could not publish update.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <AppShell page="status-pages" projectId={projectId}>
      <main id="main-content" data-watchrail-workspace className="w-full min-w-0 pb-16">
        <PageHeader
          title={incident?.title ?? 'Status-page incident'}
          description={
            incident
              ? `${stateLabel(incident.state)} · ${incident.components.map(({ displayName }) => displayName).join(', ')}`
              : 'Loading incident communication…'
          }
          backLink={{ href: base, label: 'Back to status page' }}
        />
        {loading ? (
          <div className="grid min-h-64 place-items-center text-sm text-rail-muted" role="status">
            Loading incident timeline…
          </div>
        ) : !incident ? (
          <div
            className="mt-6 rounded-rail-panel border border-rail-border bg-rail-surface p-5"
            role="alert"
          >
            <p className="m-0 text-sm text-rail-subtle">{error ?? 'Incident unavailable.'}</p>
            <Button className="mt-4" size="compact" onClick={() => void load()}>
              Try again
            </Button>
          </div>
        ) : (
          <div className="mt-6 grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_22rem]">
            <section
              className="overflow-hidden rounded-rail-panel border border-rail-border bg-rail-surface"
              aria-labelledby="incident-timeline"
            >
              <div className="border-b border-rail-border p-5 sm:p-6">
                <h2 id="incident-timeline" className="m-0 text-base font-medium text-rail-text">
                  Public timeline
                </h2>
                <p className="mt-1 mb-0 text-sm text-rail-subtle">
                  Updates appear newest first on the public incident page.
                </p>
              </div>
              <ol className="m-0 list-none divide-y divide-rail-border p-0">
                {[...incident.updates].reverse().map((update) => (
                  <li
                    key={update.id}
                    className="grid gap-3 px-5 py-5 sm:grid-cols-[minmax(0,1fr)_auto] sm:px-6"
                  >
                    <div>
                      <h3 className="m-0 text-sm font-medium text-rail-text">
                        {stateLabel(update.state)}
                      </h3>
                      <p className="mt-1 mb-0 whitespace-pre-wrap text-sm leading-6 text-rail-subtle">
                        {update.message}
                      </p>
                    </div>
                    <time
                      className="text-xs tabular-nums text-rail-muted"
                      dateTime={update.createdAt}
                    >
                      {formatter.format(new Date(update.createdAt))}
                    </time>
                  </li>
                ))}
              </ol>
            </section>
            <aside
              className="rounded-rail-panel border border-rail-border bg-rail-surface p-5 xl:sticky xl:top-20"
              aria-labelledby="publish-update"
            >
              <h2 id="publish-update" className="m-0 text-base font-medium text-rail-text">
                Publish update
              </h2>
              {incident.state === 'RESOLVED' ? (
                <p className="mt-2 mb-0 text-sm leading-6 text-rail-subtle">
                  This incident is resolved. Its timeline remains public for the retention period.
                </p>
              ) : (
                <form className="mt-4 grid gap-4" onSubmit={submit} aria-busy={submitting}>
                  <label className="grid gap-2 text-sm font-medium text-rail-text">
                    State
                    <Select
                      value={state}
                      onChange={(event) => setState(event.target.value as StatusPageIncidentState)}
                    >
                      {nextStates(incident.state).map((option) => (
                        <option key={option} value={option}>
                          {stateLabel(option)}
                        </option>
                      ))}
                    </Select>
                  </label>
                  <label className="grid gap-2 text-sm font-medium text-rail-text">
                    Customer update
                    <Textarea
                      required
                      maxLength={2000}
                      rows={6}
                      value={message}
                      onChange={(event) => setMessage(event.target.value)}
                      placeholder="Share what changed and what customers should expect next."
                    />
                  </label>
                  <Button type="submit" variant="primary" disabled={submitting}>
                    {submitting
                      ? 'Publishing…'
                      : state === 'RESOLVED'
                        ? 'Resolve incident'
                        : 'Publish update'}
                  </Button>
                </form>
              )}
              {error ? (
                <p className="mt-4 mb-0 text-sm text-rail-danger" role="alert">
                  {error}
                </p>
              ) : null}
            </aside>
          </div>
        )}
      </main>
    </AppShell>
  );
}

function nextStates(current: StatusPageIncidentState): StatusPageIncidentState[] {
  if (current === 'INVESTIGATING') return ['INVESTIGATING', 'IDENTIFIED', 'MONITORING', 'RESOLVED'];
  if (current === 'IDENTIFIED') return ['IDENTIFIED', 'MONITORING', 'RESOLVED'];
  if (current === 'MONITORING') return ['MONITORING', 'RESOLVED'];
  return [];
}
