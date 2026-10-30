'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { AppShell } from '../../components/app-shell';
import { actionClassName, Button } from '../../components/ui/button';
import {
  DataTable,
  type DataTableAction,
  type DataTableColumn,
} from '../../components/ui/data-table';
import { PageHeader } from '../../components/ui/page-header';
import type { WorkspaceStatusPage } from './types';

const dateFormatter = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' });

const columns: Array<DataTableColumn<WorkspaceStatusPage>> = [
  {
    id: 'name',
    header: 'Status page',
    cell: (page) => (
      <div>
        {page.published ? (
          <Link
            href={`/status/${page.slug}`}
            className="font-medium text-rail-text no-underline hover:text-rail-accent hover:underline"
          >
            {page.name}
          </Link>
        ) : (
          <p className="m-0 font-medium text-rail-text">{page.name}</p>
        )}
        <p className="mt-0.5 mb-0 text-xs text-rail-muted">/status/{page.slug}</p>
      </div>
    ),
  },
  {
    id: 'components',
    header: 'Components',
    className: 'text-rail-subtle tabular-nums',
    cell: (page) => page.components.length,
  },
  {
    id: 'visibility',
    header: 'Visibility',
    cell: (page) => (
      <span
        className={`inline-flex min-h-7 items-center rounded-rail-control border px-2 text-xs font-medium ${page.published ? 'border-rail-success/30 bg-rail-success/8 text-rail-success' : 'border-rail-border text-rail-subtle'}`}
      >
        {page.published ? 'Published' : 'Draft'}
      </span>
    ),
  },
  {
    id: 'updated',
    header: 'Updated',
    className: 'text-rail-subtle tabular-nums',
    cell: (page) => dateFormatter.format(new Date(page.updatedAt)),
  },
];

const actions: Array<DataTableAction<WorkspaceStatusPage>> = [
  {
    id: 'manage',
    label: 'Manage',
    href: (page) =>
      `${page.projectId ? `/projects/${page.projectId}` : ''}/status-pages/${page.id}`,
  },
  {
    id: 'edit',
    label: 'Edit',
    href: (page) =>
      `${page.projectId ? `/projects/${page.projectId}` : ''}/status-pages/${page.id}/edit`,
  },
];

export function StatusPagesPage({ projectId }: { projectId?: string | undefined }) {
  const projectBase = projectId ? `/projects/${projectId}` : '';
  const [pages, setPages] = useState<WorkspaceStatusPage[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const load = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try {
      const response = await fetch(
        `/api/status-pages${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ''}`,
        {
          headers: { Accept: 'application/json' },
        },
      );
      if (!response.ok) throw new Error();
      const body = (await response.json()) as { data: WorkspaceStatusPage[] };
      setPages(body.data);
    } catch {
      setError(
        'Watchrail could not load status pages. Check that the API and database are running.',
      );
    } finally {
      setLoading(false);
    }
  }, [projectId]);
  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  return (
    <AppShell page="status-pages" projectId={projectId}>
      <main id="main-content" data-watchrail-workspace className="w-full min-w-0 pb-16">
        <PageHeader
          title="Status pages"
          description="Publish a clear, customer-facing view of service health and incident history."
          actions={
            <Link
              href={`${projectBase}/status-pages/new`}
              className={actionClassName({ variant: 'primary' })}
            >
              <svg
                viewBox="0 0 16 16"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                aria-hidden="true"
                className="size-3.5"
              >
                <path d="M8 3v10M3 8h10" />
              </svg>
              Create status page
            </Link>
          }
        />
        <section className="mt-6 overflow-hidden rounded-rail-panel border border-rail-border bg-rail-surface">
          {loading ? (
            <div className="grid min-h-52 place-items-center text-sm text-rail-muted" role="status">
              Loading status pages…
            </div>
          ) : error ? (
            <div className="px-5 py-12 text-center" role="alert">
              <h2 className="m-0 text-base font-medium text-rail-text">
                Status pages are unavailable
              </h2>
              <p className="mx-auto mt-2 mb-4 max-w-md text-sm leading-6 text-rail-subtle">
                {error}
              </p>
              <Button onClick={() => void load()}>Try again</Button>
            </div>
          ) : pages.length === 0 ? (
            <div className="px-5 py-12 text-center">
              <h2 className="m-0 text-base font-medium text-rail-text">No status pages yet</h2>
              <p className="mx-auto mt-2 mb-0 max-w-md text-sm leading-6 text-rail-subtle">
                Select monitors and publish authoritative availability without exposing private
                diagnostics.
              </p>
              <Link
                href={`${projectBase}/status-pages/new`}
                className={actionClassName({ variant: 'primary', className: 'mt-4' })}
              >
                Create status page
              </Link>
            </div>
          ) : (
            <DataTable
              rows={pages}
              columns={columns}
              actions={actions}
              getRowKey={(page) => page.id}
              getRowHref={(page) => `${projectBase}/status-pages/${page.id}`}
              getRowLabel={(page) => page.name}
              ariaLabel="Workspace status pages"
              minWidthClassName="min-w-[680px]"
            />
          )}
        </section>
      </main>
    </AppShell>
  );
}
