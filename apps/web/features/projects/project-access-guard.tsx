'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';

type AccessState = 'checking' | 'ready' | 'redirecting' | 'error';

export function ProjectAccessGuard({
  children,
  projectId,
}: {
  children: ReactNode;
  projectId: string;
}) {
  const router = useRouter();
  const [state, setState] = useState<AccessState>('checking');

  useEffect(() => {
    const controller = new AbortController();

    void fetch(`/api/projects/${encodeURIComponent(projectId)}`, {
      headers: { Accept: 'application/json' },
      signal: controller.signal,
      cache: 'no-store',
    })
      .then((response) => {
        if (response.ok) {
          setState('ready');
          return;
        }
        if ([400, 403, 404].includes(response.status)) {
          setState('redirecting');
          router.replace('/projects');
          return;
        }
        setState('error');
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === 'AbortError') return;
        setState('error');
      });

    return () => controller.abort();
  }, [projectId, router]);

  if (state === 'ready') return children;

  return (
    <main className="grid min-h-screen place-items-center bg-rail-workspace px-4 text-center">
      {state === 'error' ? (
        <div>
          <h1 className="m-0 text-base font-semibold text-rail-text">
            Project could not be opened
          </h1>
          <p className="mt-2 mb-4 text-sm text-rail-subtle">
            Watchrail could not verify this project. Try again or return to your projects.
          </p>
          <div className="flex items-center justify-center gap-3">
            <button
              type="button"
              className="min-h-9 rounded-rail-control border border-rail-border bg-rail-raised px-3 text-sm text-rail-text hover:bg-rail-hover"
              onClick={() => window.location.reload()}
            >
              Try again
            </button>
            <Link
              className="text-sm text-rail-accent no-underline hover:underline"
              href="/projects"
            >
              View projects
            </Link>
          </div>
        </div>
      ) : (
        <p className="m-0 text-sm text-rail-muted" role="status">
          {state === 'redirecting' ? 'Returning to projects…' : 'Opening project…'}
        </p>
      )}
    </main>
  );
}
