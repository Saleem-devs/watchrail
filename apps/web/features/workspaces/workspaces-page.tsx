'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { AppShell } from '../../components/app-shell';
import { actionClassName } from '../../components/ui/button';
import { Input } from '../../components/ui/form-control';
import { PageHeader } from '../../components/ui/page-header';
import { authClient } from '../../lib/auth-client';
import type { WorkspaceSummary } from './types';

export function WorkspacesPage() {
  const router = useRouter();
  const { data: session } = authClient.useSession();
  const [workspaces, setWorkspaces] = useState<WorkspaceSummary[]>([]);
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [switchingId, setSwitchingId] = useState<string>();
  const [error, setError] = useState<string>();

  const load = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try {
      const result = await authClient.organization.list();
      if (result.error) throw new Error(result.error.message);
      setWorkspaces(result.data ?? []);
    } catch {
      setError('Watchrail could not load your workspaces. Try again.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  const visibleWorkspaces = useMemo(() => {
    const term = query.trim().toLocaleLowerCase();
    return term
      ? workspaces.filter((workspace) => workspace.name.toLocaleLowerCase().includes(term))
      : workspaces;
  }, [query, workspaces]);

  async function openWorkspace(workspace: WorkspaceSummary) {
    if (workspace.id === session?.session.activeOrganizationId) {
      router.push(`/workspaces/${workspace.id}`);
      return;
    }
    setSwitchingId(workspace.id);
    setError(undefined);
    const result = await authClient.organization.setActive({ organizationId: workspace.id });
    if (result.error) {
      setError('Watchrail could not switch workspaces. Try again.');
      setSwitchingId(undefined);
      return;
    }
    router.push(`/workspaces/${workspace.id}`);
    router.refresh();
  }

  return (
    <AppShell page="workspaces">
      <main id="main-content" data-watchrail-workspace className="w-full min-w-0 pb-16">
        <PageHeader
          title="Workspaces"
          description="Manage the workspaces you belong to and switch between their projects."
          actions={
            <Link href="/workspaces/new" className={actionClassName({ variant: 'primary' })}>
              <svg
                viewBox="0 0 16 16"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.6"
                className="size-4"
                aria-hidden="true"
              >
                <path d="M8 3v10M3 8h10" strokeLinecap="round" />
              </svg>
              Create workspace
            </Link>
          }
        />

        <div className="mt-6 max-w-md">
          <label htmlFor="workspace-search" className="sr-only">
            Search workspaces
          </label>
          <Input
            id="workspace-search"
            type="search"
            value={query}
            placeholder="Search workspaces"
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>

        {loading ? (
          <div className="mt-6 grid min-h-48 place-items-center border-y border-rail-border text-sm text-rail-muted">
            Loading workspaces…
          </div>
        ) : error ? (
          <div className="mt-6 grid min-h-48 place-items-center border-y border-rail-border py-10 text-center">
            <div>
              <p role="alert" className="m-0 text-sm text-rail-danger">
                {error}
              </p>
              <button
                type="button"
                className={actionClassName({ variant: 'secondary', className: 'mt-4' })}
                onClick={() => void load()}
              >
                Try again
              </button>
            </div>
          </div>
        ) : visibleWorkspaces.length === 0 ? (
          <div className="mt-6 border-y border-rail-border py-14 text-center">
            <h2 className="m-0 text-base font-medium text-rail-text">
              {workspaces.length === 0 ? 'Create your first workspace' : 'No workspaces match'}
            </h2>
            <p className="mx-auto mt-2 mb-0 max-w-md text-sm text-rail-subtle">
              {workspaces.length === 0
                ? 'A workspace keeps projects, members, and access settings together.'
                : 'Try a different workspace name.'}
            </p>
          </div>
        ) : (
          <ul className="mt-6 grid list-none gap-3 p-0 sm:grid-cols-2 xl:grid-cols-3">
            {visibleWorkspaces.map((workspace) => {
              const active = workspace.id === session?.session.activeOrganizationId;
              return (
                <li key={workspace.id}>
                  <button
                    type="button"
                    disabled={switchingId !== undefined}
                    onClick={() => void openWorkspace(workspace)}
                    className="flex min-h-32 w-full items-start justify-between gap-4 rounded-rail-panel border border-rail-border bg-rail-surface p-5 text-left transition-colors hover:border-rail-border-strong hover:bg-rail-hover disabled:cursor-wait disabled:opacity-60"
                  >
                    <span className="min-w-0">
                      <strong className="block truncate text-sm font-semibold text-rail-text">
                        {workspace.name}
                      </strong>
                      <span className="mt-2 block truncate text-xs text-rail-muted">
                        /{workspace.slug}
                      </span>
                    </span>
                    <span
                      className={`shrink-0 text-xs ${active ? 'text-rail-accent' : 'text-rail-muted'}`}
                    >
                      {switchingId === workspace.id ? 'Switching…' : active ? 'Current' : 'Open'}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </main>
    </AppShell>
  );
}
