'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { AppShell } from '../../components/app-shell';
import { actionClassName, Button } from '../../components/ui/button';
import { PageHeader } from '../../components/ui/page-header';
import { apiErrorMessage, loadStatusPage, loadStatusPageMonitors } from './status-page-api';
import { publicMonitorState } from './status-page-status';
import type { StatusPageApiError, StatusPageMonitor, WorkspaceStatusPage } from './types';

const dateFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeStyle: 'short',
});

export function StatusPageManagement({
  statusPageId,
  projectId,
}: {
  statusPageId: string;
  projectId?: string | undefined;
}) {
  const projectBase = projectId ? `/projects/${projectId}` : '';
  const [page, setPage] = useState<WorkspaceStatusPage>();
  const [monitors, setMonitors] = useState<StatusPageMonitor[]>([]);
  const [loading, setLoading] = useState(true);
  const [publishing, setPublishing] = useState(false);
  const [error, setError] = useState<string>();

  const load = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try {
      const [loadedPage, loadedMonitors] = await Promise.all([
        loadStatusPage(statusPageId),
        loadStatusPageMonitors(projectId),
      ]);
      setPage(loadedPage);
      setMonitors(loadedMonitors);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Could not load status page.');
    } finally {
      setLoading(false);
    }
  }, [projectId, statusPageId]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  const monitorById = useMemo(
    () => new Map(monitors.map((monitor) => [monitor.id, monitor])),
    [monitors],
  );

  async function setPublished(published: boolean): Promise<void> {
    if (!page) return;
    setPublishing(true);
    setError(undefined);
    try {
      const response = await fetch(`/api/status-pages/${page.id}/publication`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ published }),
      });
      const body = (await response.json()) as { data?: WorkspaceStatusPage } & StatusPageApiError;
      if (!response.ok || !body.data) {
        throw new Error(
          apiErrorMessage(body, `Could not ${published ? 'publish' : 'unpublish'} status page.`),
        );
      }
      setPage(body.data);
    } catch (publicationError) {
      setError(
        publicationError instanceof Error
          ? publicationError.message
          : `Could not ${published ? 'publish' : 'unpublish'} status page.`,
      );
    } finally {
      setPublishing(false);
    }
  }

  return (
    <AppShell page="status-pages" projectId={projectId}>
      <main id="main-content" data-watchrail-workspace className="w-full min-w-0 pb-16">
        <PageHeader
          title={page?.name ?? 'Status page'}
          description={
            page
              ? `${page.published ? 'Published' : 'Draft'} at /status/${page.slug}`
              : 'Manage the public service-health presentation for this workspace.'
          }
          backLink={{ href: `${projectBase}/status-pages`, label: 'Back to status pages' }}
          actions={
            page ? (
              <>
                {page.published ? (
                  <Link
                    href={`/status/${page.slug}`}
                    target="_blank"
                    rel="noreferrer"
                    className={actionClassName({ variant: 'secondary' })}
                  >
                    Open public page
                  </Link>
                ) : null}
                <Link
                  href={`${projectBase}/status-pages/${page.id}/edit`}
                  className={actionClassName({ variant: 'secondary' })}
                >
                  Edit
                </Link>
                <Button
                  variant={page.published ? 'secondary' : 'primary'}
                  disabled={publishing || page.components.length === 0}
                  onClick={() => void setPublished(!page.published)}
                >
                  {publishing
                    ? page.published
                      ? 'Unpublishing…'
                      : 'Publishing…'
                    : page.published
                      ? 'Unpublish'
                      : 'Publish'}
                </Button>
              </>
            ) : undefined
          }
        />

        {loading ? (
          <div className="grid min-h-64 place-items-center text-sm text-rail-muted" role="status">
            Loading status page…
          </div>
        ) : !page ? (
          <section
            className="mt-6 rounded-rail-panel border border-rail-border bg-rail-surface px-5 py-12 text-center"
            role="alert"
          >
            <h2 className="m-0 text-base font-medium text-rail-text">Status page unavailable</h2>
            <p className="mx-auto mt-2 mb-4 max-w-md text-sm leading-6 text-rail-subtle">
              {error ?? 'Watchrail could not find this status page.'}
            </p>
            <Button onClick={() => void load()}>Try again</Button>
          </section>
        ) : (
          <div className="mt-6 grid gap-6 xl:grid-cols-[minmax(0,1fr)_22rem]">
            <section
              className="overflow-hidden rounded-rail-panel border border-rail-border bg-rail-surface"
              aria-labelledby="public-service-preview"
            >
              <div className="flex flex-wrap items-start justify-between gap-4 border-b border-rail-border p-5 sm:p-6">
                <div>
                  <h2
                    id="public-service-preview"
                    className="m-0 text-base font-medium text-rail-text"
                  >
                    Public service preview
                  </h2>
                  <p className="mt-1 mb-0 text-sm text-rail-subtle">
                    Lifecycle-aware states derived from the latest authoritative monitor evidence.
                  </p>
                </div>
                <VisibilityBadge published={page.published} />
              </div>
              {page.components.length === 0 ? (
                <div className="px-5 py-12 text-center sm:px-6">
                  <h3 className="m-0 text-sm font-medium text-rail-text">No public components</h3>
                  <p className="mx-auto mt-2 mb-4 max-w-md text-sm leading-6 text-rail-subtle">
                    Add at least one monitor before publishing this page.
                  </p>
                  <Link
                    href={`${projectBase}/status-pages/${page.id}/edit`}
                    className={actionClassName({ variant: 'secondary' })}
                  >
                    Add components
                  </Link>
                </div>
              ) : (
                <ol className="m-0 list-none divide-y divide-rail-border p-0">
                  {[...page.components]
                    .sort((left, right) => left.position - right.position)
                    .map((component) => {
                      const monitor = monitorById.get(component.monitorId);
                      const state = publicMonitorState(monitor);
                      return (
                        <li
                          key={component.id}
                          className="flex min-h-16 items-center justify-between gap-6 px-5 py-3 sm:px-6"
                        >
                          <div className="min-w-0">
                            <p className="m-0 truncate text-sm font-medium text-rail-text">
                              {component.displayName}
                            </p>
                            <p className="mt-0.5 mb-0 truncate text-xs text-rail-muted">
                              {monitor?.name ?? 'Monitor no longer available'}
                            </p>
                          </div>
                          <span className={`shrink-0 text-sm font-medium ${state.className}`}>
                            {state.label}
                          </span>
                        </li>
                      );
                    })}
                </ol>
              )}
            </section>

            <aside
              className="self-start overflow-hidden rounded-rail-panel border border-rail-border bg-rail-surface"
              aria-labelledby="status-page-details"
            >
              <div className="border-b border-rail-border p-5">
                <h2 id="status-page-details" className="m-0 text-base font-medium text-rail-text">
                  Page details
                </h2>
              </div>
              <dl className="m-0 divide-y divide-rail-border px-5">
                <Detail label="Visibility" value={page.published ? 'Published' : 'Draft'} />
                <Detail label="Public URL" value={`/status/${page.slug}`} />
                <Detail label="Components" value={String(page.components.length)} />
                <Detail label="Updated" value={dateFormatter.format(new Date(page.updatedAt))} />
              </dl>
            </aside>

            {error ? (
              <div
                className="xl:col-span-2 rounded-rail-control border border-rail-danger/30 bg-rail-danger/8 px-4 py-3 text-sm text-rail-danger"
                role="alert"
              >
                {error} Try again.
              </div>
            ) : null}
          </div>
        )}
      </main>
    </AppShell>
  );
}

function VisibilityBadge({ published }: { published: boolean }) {
  return (
    <span
      className={`inline-flex min-h-7 items-center rounded-rail-control border px-2 text-xs font-medium ${published ? 'border-rail-success/30 bg-rail-success/8 text-rail-success' : 'border-rail-border text-rail-subtle'}`}
    >
      {published ? 'Published' : 'Draft'}
    </span>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid gap-1 py-4">
      <dt className="text-xs text-rail-muted">{label}</dt>
      <dd className="m-0 break-words text-sm text-rail-text">{value}</dd>
    </div>
  );
}
