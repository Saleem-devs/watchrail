'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import type { WorkspaceProject } from '../features/projects/types';

export function ProjectSwitcher({ projectId }: { projectId?: string | undefined }) {
  const [projects, setProjects] = useState<WorkspaceProject[]>([]);
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const current = projects.find((project) => project.id === projectId);

  useEffect(() => {
    const controller = new AbortController();
    void fetch('/api/projects', {
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) return;
        const body = (await response.json()) as { data: WorkspaceProject[] };
        setProjects(body.data);
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      if (!wrapperRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);

  if (!projectId) {
    return (
      <Link
        href="/projects"
        className="text-[13px] font-medium text-rail-subtle no-underline hover:text-rail-text"
      >
        Projects
      </Link>
    );
  }

  return (
    <div ref={wrapperRef} className="relative flex min-w-0 items-center gap-1.5">
      <span aria-hidden="true" className="text-rail-muted">
        /
      </span>
      <button
        type="button"
        className="inline-flex min-h-8 min-w-0 items-center gap-1.5 rounded-rail-control px-2 text-[13px] font-medium text-rail-text hover:bg-rail-hover"
        aria-expanded={open}
        aria-haspopup="menu"
        onClick={() => setOpen((value) => !value)}
      >
        <span className="truncate">{current?.name ?? 'Project'}</span>
        <svg
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          className="size-3.5 text-rail-muted"
          aria-hidden="true"
        >
          <path d="m4 6 4 4 4-4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open ? (
        <div
          role="menu"
          className="absolute top-[calc(100%+0.45rem)] left-3 z-[70] w-64 rounded-rail-panel border border-rail-border bg-rail-overlay p-1.5 shadow-[0_18px_50px_var(--color-rail-shadow)]"
        >
          <p className="m-0 px-2.5 py-2 text-xs text-rail-muted">Switch project</p>
          {projects.map((project) => (
            <Link
              key={project.id}
              role="menuitem"
              href={`/projects/${project.id}`}
              className={`flex min-h-9 items-center justify-between rounded-rail-control px-2.5 text-sm no-underline hover:bg-rail-hover ${project.id === projectId ? 'bg-rail-selected text-rail-text' : 'text-rail-subtle'}`}
            >
              <span className="truncate">{project.name}</span>
              <span className="ml-3 text-xs tabular-nums text-rail-muted">
                {project.monitorCount}
              </span>
            </Link>
          ))}
          <div className="my-1 border-t border-rail-border" />
          <Link
            role="menuitem"
            href="/projects"
            className="flex min-h-9 items-center rounded-rail-control px-2.5 text-sm text-rail-subtle no-underline hover:bg-rail-hover hover:text-rail-text"
          >
            All projects
          </Link>
        </div>
      ) : null}
    </div>
  );
}
