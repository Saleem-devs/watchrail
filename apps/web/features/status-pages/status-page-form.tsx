'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { AppShell } from '../../components/app-shell';
import { actionClassName, Button } from '../../components/ui/button';
import { PageHeader } from '../../components/ui/page-header';
import { apiErrorMessage, loadStatusPage, loadStatusPageMonitors } from './status-page-api';
import { publicMonitorState } from './status-page-status';
import type {
  StatusPageApiError,
  StatusPageComponentDraft,
  StatusPageMonitor,
  WorkspaceStatusPage,
} from './types';

const formId = 'status-page-form';

export function StatusPageForm({
  mode,
  statusPageId,
  projectId,
}: {
  mode: 'create' | 'edit';
  statusPageId?: string;
  projectId?: string | undefined;
}) {
  const router = useRouter();
  const [page, setPage] = useState<WorkspaceStatusPage>();
  const [monitors, setMonitors] = useState<StatusPageMonitor[]>([]);
  const [name, setName] = useState('');
  const [logoUrl, setLogoUrl] = useState('');
  const [slug, setSlug] = useState('');
  const [slugEdited, setSlugEdited] = useState(false);
  const [components, setComponents] = useState<StatusPageComponentDraft[]>([]);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [loadError, setLoadError] = useState<string>();
  const [error, setError] = useState<string>();

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(undefined);
    try {
      const [loadedMonitors, loadedPage] = await Promise.all([
        loadStatusPageMonitors(projectId),
        mode === 'edit' && statusPageId ? loadStatusPage(statusPageId) : Promise.resolve(undefined),
      ]);
      setMonitors(loadedMonitors);
      if (loadedPage) {
        setPage(loadedPage);
        setName(loadedPage.name);
        setLogoUrl(loadedPage.logoUrl ?? '');
        setSlug(loadedPage.slug);
        setSlugEdited(true);
        setComponents(
          [...loadedPage.components]
            .sort((left, right) => left.position - right.position)
            .map(({ monitorId, displayName, groupName }) => ({
              monitorId,
              displayName,
              groupName: groupName ?? '',
            })),
        );
      }
    } catch (loadError) {
      setLoadError(
        loadError instanceof Error ? loadError.message : 'Could not load status-page setup.',
      );
    } finally {
      setLoading(false);
    }
  }, [mode, projectId, statusPageId]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  const selectedIds = useMemo(
    () => new Set(components.map((component) => component.monitorId)),
    [components],
  );

  function updateName(value: string): void {
    setName(value);
    if (!slugEdited) setSlug(slugFromName(value));
  }

  function toggleMonitor(monitor: StatusPageMonitor): void {
    setComponents((current) =>
      current.some((component) => component.monitorId === monitor.id)
        ? current.filter((component) => component.monitorId !== monitor.id)
        : [...current, { monitorId: monitor.id, displayName: monitor.name, groupName: '' }],
    );
  }

  function updateDisplayName(monitorId: string, displayName: string): void {
    setComponents((current) =>
      current.map((component) =>
        component.monitorId === monitorId ? { ...component, displayName } : component,
      ),
    );
  }

  function updateGroupName(monitorId: string, groupName: string): void {
    setComponents((current) =>
      current.map((component) =>
        component.monitorId === monitorId ? { ...component, groupName } : component,
      ),
    );
  }

  function moveComponent(index: number, direction: -1 | 1): void {
    setComponents((current) => {
      const target = index + direction;
      if (target < 0 || target >= current.length) return current;
      const next = [...current];
      const item = next[index];
      const replacement = next[target];
      if (!item || !replacement) return current;
      next[index] = replacement;
      next[target] = item;
      return next;
    });
  }

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setSubmitting(true);
    setError(undefined);
    const payloadComponents = components.map((component, position) => ({
      ...component,
      groupName: component.groupName.trim() || null,
      position,
    }));
    try {
      let savedPage: WorkspaceStatusPage;
      if (mode === 'create') {
        const response = await fetch(
          `/api/status-pages${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ''}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
            body: JSON.stringify({
              name,
              logoUrl: logoUrl.trim() || null,
              slug,
              published: false,
              components: payloadComponents,
            }),
          },
        );
        const body = (await response.json()) as { data?: WorkspaceStatusPage } & StatusPageApiError;
        if (!response.ok || !body.data) {
          throw new Error(apiErrorMessage(body, 'Could not create status page.'));
        }
        savedPage = body.data;
      } else {
        if (!statusPageId) throw new Error('Status page identifier is missing.');
        const settingsResponse = await fetch(`/api/status-pages/${statusPageId}/settings`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({ name, logoUrl: logoUrl.trim() || null, slug }),
        });
        const settingsBody = (await settingsResponse.json()) as {
          data?: WorkspaceStatusPage;
        } & StatusPageApiError;
        if (!settingsResponse.ok || !settingsBody.data) {
          throw new Error(apiErrorMessage(settingsBody, 'Could not update status-page settings.'));
        }
        const componentsResponse = await fetch(`/api/status-pages/${statusPageId}/components`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({ components: payloadComponents }),
        });
        const componentsBody = (await componentsResponse.json()) as {
          data?: WorkspaceStatusPage;
        } & StatusPageApiError;
        if (!componentsResponse.ok || !componentsBody.data) {
          throw new Error(apiErrorMessage(componentsBody, 'Could not update public components.'));
        }
        savedPage = componentsBody.data;
      }
      router.push(`${projectId ? `/projects/${projectId}` : ''}/status-pages/${savedPage.id}`);
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : 'Could not save status page.');
    } finally {
      setSubmitting(false);
    }
  }

  const projectBase = projectId ? `/projects/${projectId}` : '';
  const cancelHref = page
    ? `${projectBase}/status-pages/${page.id}`
    : `${projectBase}/status-pages`;

  return (
    <AppShell page="status-pages" projectId={projectId}>
      <main id="main-content" data-watchrail-workspace className="w-full min-w-0 pb-16">
        <PageHeader
          title={mode === 'create' ? 'Create status page' : 'Edit status page'}
          description="Choose what customers can see. Private diagnostics and monitor configuration remain inside Watchrail."
          backLink={{
            href: cancelHref,
            label: page ? 'Back to status page' : 'Back to status pages',
          }}
          actions={
            <>
              <Link href={cancelHref} className={actionClassName({ variant: 'quiet' })}>
                Cancel
              </Link>
              <Button
                type="submit"
                form={formId}
                variant="primary"
                disabled={loading || Boolean(loadError) || submitting}
              >
                {submitting ? 'Saving…' : mode === 'create' ? 'Save draft' : 'Save changes'}
              </Button>
            </>
          }
        />

        {loading ? (
          <div className="grid min-h-64 place-items-center text-sm text-rail-muted" role="status">
            Loading status-page setup…
          </div>
        ) : loadError ? (
          <section
            className="mt-6 rounded-rail-panel border border-rail-border bg-rail-surface px-5 py-12 text-center"
            role="alert"
          >
            <h2 className="m-0 text-base font-medium text-rail-text">
              Status-page setup is unavailable
            </h2>
            <p className="mx-auto mt-2 mb-4 max-w-md text-sm leading-6 text-rail-subtle">
              {loadError}
            </p>
            <Button onClick={() => void load()}>Try again</Button>
          </section>
        ) : (
          <form
            id={formId}
            className="mt-6 grid gap-6 xl:grid-cols-[minmax(0,1fr)_22rem]"
            onSubmit={submit}
          >
            <div className="min-w-0 overflow-hidden rounded-rail-panel border border-rail-border bg-rail-surface">
              <section className="p-5 sm:p-6" aria-labelledby="status-page-details">
                <h2 id="status-page-details" className="m-0 text-base font-medium text-rail-text">
                  Page details
                </h2>
                <p className="mt-1 mb-5 text-sm text-rail-subtle">
                  Name the page and reserve a stable public URL.
                </p>
                <div className="grid gap-4 sm:grid-cols-2">
                  <label className="grid gap-2 text-sm font-medium text-rail-text">
                    Name
                    <input
                      name="name"
                      required
                      maxLength={100}
                      value={name}
                      onChange={(event) => updateName(event.target.value)}
                      className="min-h-10 rounded-rail-control border border-rail-border-strong bg-rail-input px-3 text-sm text-rail-text outline-none focus:border-rail-accent focus:ring-1 focus:ring-rail-accent"
                      placeholder="Customer-facing service status"
                    />
                  </label>
                  <label className="grid gap-2 text-sm font-medium text-rail-text">
                    Public slug
                    <input
                      name="slug"
                      required
                      minLength={3}
                      maxLength={63}
                      pattern="[a-z0-9]+(?:-[a-z0-9]+)*"
                      value={slug}
                      onChange={(event) => {
                        setSlugEdited(true);
                        setSlug(event.target.value.toLowerCase());
                      }}
                      className="min-h-10 rounded-rail-control border border-rail-border-strong bg-rail-input px-3 text-sm text-rail-text outline-none focus:border-rail-accent focus:ring-1 focus:ring-rail-accent"
                      placeholder="service-status"
                      aria-describedby="status-page-url-preview"
                    />
                  </label>
                </div>
                <p id="status-page-url-preview" className="mt-3 mb-0 text-xs text-rail-muted">
                  Public URL: /status/{slug || 'service-status'}
                </p>
                <label className="mt-4 grid gap-2 text-sm font-medium text-rail-text">
                  Brand logo URL
                  <input
                    name="logoUrl"
                    type="url"
                    maxLength={2048}
                    value={logoUrl}
                    onChange={(event) => setLogoUrl(event.target.value)}
                    className="min-h-10 rounded-rail-control border border-rail-border-strong bg-rail-input px-3 text-sm text-rail-text outline-none focus:border-rail-accent focus:ring-1 focus:ring-rail-accent"
                    aria-describedby="status-page-logo-help"
                  />
                  <span id="status-page-logo-help" className="text-xs font-normal text-rail-muted">
                    Optional. Use a square SVG or PNG hosted on your domain.
                  </span>
                </label>
              </section>

              <section
                className="border-t border-rail-border p-5 sm:p-6"
                aria-labelledby="public-components"
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <h2 id="public-components" className="m-0 text-base font-medium text-rail-text">
                      Public components
                    </h2>
                    <p className="mt-1 mb-0 text-sm text-rail-subtle">
                      Select monitors, rename them for customers, and set their display order.
                    </p>
                  </div>
                  <span className="text-xs tabular-nums text-rail-muted">
                    {components.length} selected
                  </span>
                </div>

                {monitors.length === 0 ? (
                  <p className="mt-5 rounded-rail-control border border-dashed border-rail-border-strong px-4 py-3 text-sm text-rail-subtle">
                    Create a monitor before adding public components.
                  </p>
                ) : (
                  <div className="mt-5 divide-y divide-rail-border border-y border-rail-border">
                    {monitors.map((monitor) => {
                      const checked = selectedIds.has(monitor.id);
                      const componentIndex = components.findIndex(
                        (component) => component.monitorId === monitor.id,
                      );
                      const component = components[componentIndex];
                      return (
                        <div key={monitor.id} className="py-4 first:pt-3 last:pb-3">
                          <label className="flex min-h-11 cursor-pointer items-start gap-3">
                            <input
                              type="checkbox"
                              checked={checked}
                              onChange={() => toggleMonitor(monitor)}
                              className="mt-0.5 size-4 accent-rail-accent"
                            />
                            <span className="min-w-0 flex-1">
                              <span className="block truncate text-sm font-medium text-rail-text">
                                {monitor.name}
                              </span>
                              <span className="mt-0.5 block truncate text-xs text-rail-muted">
                                {monitor.url}
                              </span>
                            </span>
                            <span
                              className={`shrink-0 text-xs ${publicMonitorState(monitor).className}`}
                            >
                              {publicMonitorState(monitor).label}
                            </span>
                          </label>
                          {checked && component ? (
                            <div className="mt-3 grid gap-3 pl-7 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] sm:items-end">
                              <label className="grid gap-1.5 text-xs font-medium text-rail-subtle">
                                Public display name
                                <input
                                  required
                                  maxLength={100}
                                  value={component.displayName}
                                  onChange={(event) =>
                                    updateDisplayName(monitor.id, event.target.value)
                                  }
                                  className="min-h-9 rounded-rail-control border border-rail-border-strong bg-rail-input px-3 text-sm text-rail-text outline-none focus:border-rail-accent focus:ring-1 focus:ring-rail-accent"
                                />
                              </label>
                              <label className="grid gap-1.5 text-xs font-medium text-rail-subtle">
                                Group
                                <input
                                  maxLength={100}
                                  value={component.groupName}
                                  onChange={(event) =>
                                    updateGroupName(monitor.id, event.target.value)
                                  }
                                  className="min-h-9 rounded-rail-control border border-rail-border-strong bg-rail-input px-3 text-sm text-rail-text outline-none focus:border-rail-accent focus:ring-1 focus:ring-rail-accent"
                                  placeholder="Services"
                                />
                              </label>
                              <div
                                className="flex items-center gap-1"
                                aria-label={`Order ${component.displayName}`}
                              >
                                <Button
                                  size="compact"
                                  aria-label={`Move ${component.displayName} up`}
                                  disabled={componentIndex === 0}
                                  onClick={() => moveComponent(componentIndex, -1)}
                                >
                                  <ArrowIcon direction="up" />
                                </Button>
                                <Button
                                  size="compact"
                                  aria-label={`Move ${component.displayName} down`}
                                  disabled={componentIndex === components.length - 1}
                                  onClick={() => moveComponent(componentIndex, 1)}
                                >
                                  <ArrowIcon direction="down" />
                                </Button>
                              </div>
                            </div>
                          ) : null}
                        </div>
                      );
                    })}
                  </div>
                )}
              </section>
            </div>

            <aside
              className="self-start rounded-rail-panel border border-rail-border bg-rail-surface xl:sticky xl:top-20"
              aria-labelledby="composition-preview"
            >
              <div className="border-b border-rail-border p-5">
                <h2 id="composition-preview" className="m-0 text-base font-medium text-rail-text">
                  Public composition
                </h2>
                <p className="mt-1 mb-0 text-sm text-rail-subtle">
                  A draft summary of the services customers will see.
                </p>
              </div>
              <div className="p-5">
                <p className="m-0 text-sm font-medium text-rail-text">
                  {name || 'Untitled status page'}
                </p>
                <p className="mt-1 mb-5 text-xs text-rail-muted">
                  /status/{slug || 'service-status'}
                </p>
                {components.length === 0 ? (
                  <p className="m-0 rounded-rail-control bg-rail-sidebar px-3 py-3 text-sm text-rail-subtle">
                    Select at least one monitor to make this page useful.
                  </p>
                ) : (
                  <div className="grid gap-5">
                    {groupDraftComponents(components).map((group) => (
                      <section key={group.name}>
                        <h3 className="m-0 text-xs font-medium text-rail-muted">{group.name}</h3>
                        <ol className="m-0 mt-2 list-none divide-y divide-rail-border p-0">
                          {group.components.map((component) => {
                            const monitor = monitors.find(
                              (item) => item.id === component.monitorId,
                            );
                            const state = publicMonitorState(monitor);
                            return (
                              <li
                                key={component.monitorId}
                                className="flex items-center justify-between gap-4 py-3 first:pt-0 last:pb-0"
                              >
                                <span className="min-w-0 truncate text-sm text-rail-text">
                                  {component.displayName || monitor?.name || 'Unnamed component'}
                                </span>
                                <span className={`shrink-0 text-xs font-medium ${state.className}`}>
                                  {state.label}
                                </span>
                              </li>
                            );
                          })}
                        </ol>
                      </section>
                    ))}
                  </div>
                )}
              </div>
            </aside>

            {error ? (
              <div
                className="xl:col-span-2 rounded-rail-control border border-rail-danger/30 bg-rail-danger/8 px-4 py-3 text-sm text-rail-danger"
                role="alert"
              >
                {error} Review the page details and try again.
              </div>
            ) : null}
          </form>
        )}
      </main>
    </AppShell>
  );
}

function groupDraftComponents(components: StatusPageComponentDraft[]) {
  const groups = new Map<string, StatusPageComponentDraft[]>();
  for (const component of components) {
    const name = component.groupName.trim() || 'Services';
    const collection = groups.get(name) ?? [];
    collection.push(component);
    groups.set(name, collection);
  }
  return [...groups].map(([name, groupedComponents]) => ({ name, components: groupedComponents }));
}

function slugFromName(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63);
}

function ArrowIcon({ direction }: { direction: 'up' | 'down' }) {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="size-3.5"
      aria-hidden="true"
    >
      {direction === 'up' ? <path d="m4 10 4-4 4 4" /> : <path d="m4 6 4 4 4-4" />}
    </svg>
  );
}
