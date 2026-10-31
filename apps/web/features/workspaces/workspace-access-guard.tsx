'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';
import { authClient } from '../../lib/auth-client';

type GuardState = 'checking' | 'ready' | 'redirecting' | 'error';

export function WorkspaceAccessGuard({
  children,
  workspaceId,
}: {
  children: ReactNode;
  workspaceId: string;
}) {
  const router = useRouter();
  const { data: session, isPending } = authClient.useSession();
  const [state, setState] = useState<GuardState>('checking');

  useEffect(() => {
    if (isPending) return;
    let cancelled = false;

    async function activateWorkspace() {
      const workspaces = await authClient.organization.list();
      if (cancelled) return;
      if (workspaces.error || !workspaces.data?.some((workspace) => workspace.id === workspaceId)) {
        setState('redirecting');
        router.replace('/workspaces');
        return;
      }

      if (session?.session.activeOrganizationId !== workspaceId) {
        const result = await authClient.organization.setActive({ organizationId: workspaceId });
        if (cancelled) return;
        if (result.error) {
          setState('error');
          return;
        }
      }

      setState('ready');
    }

    void activateWorkspace().catch(() => {
      if (!cancelled) setState('error');
    });
    return () => {
      cancelled = true;
    };
  }, [isPending, router, session?.session.activeOrganizationId, workspaceId]);

  if (state === 'ready') return children;

  return (
    <main className="grid min-h-screen place-items-center bg-rail-workspace px-4 text-center">
      {state === 'error' ? (
        <div>
          <h1 className="m-0 text-base font-semibold text-rail-text">
            Workspace could not be opened
          </h1>
          <p className="mt-2 mb-4 text-sm text-rail-subtle">
            Watchrail could not activate this workspace. Try again or view all workspaces.
          </p>
          <div className="flex items-center justify-center gap-3">
            <button
              type="button"
              className="min-h-9 rounded-rail-control border border-rail-border bg-rail-raised px-3 text-sm text-rail-text hover:bg-rail-hover"
              onClick={() => window.location.reload()}
            >
              Try again
            </button>
            <button
              type="button"
              className="border-0 bg-transparent p-0 text-sm text-rail-accent hover:underline"
              onClick={() => router.replace('/workspaces')}
            >
              All workspaces
            </button>
          </div>
        </div>
      ) : (
        <p className="m-0 text-sm text-rail-muted" role="status">
          {state === 'redirecting' ? 'Returning to workspaces…' : 'Opening workspace…'}
        </p>
      )}
    </main>
  );
}
