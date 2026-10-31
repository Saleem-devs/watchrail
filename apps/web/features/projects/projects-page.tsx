'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { AppShell } from '../../components/app-shell';
import { actionClassName, Button } from '../../components/ui/button';
import { Input } from '../../components/ui/form-control';
import { Form } from '../../components/ui/form';
import { PageHeader } from '../../components/ui/page-header';
import type { ProjectApiError, WorkspaceProject } from './types';

export function ProjectsPage({ workspaceId }: { workspaceId: string }) {
  const router = useRouter();
  const [projects, setProjects] = useState<WorkspaceProject[]>([]);
  const [query, setQuery] = useState('');
  const [creating, setCreating] = useState(false);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string>();
  const [fieldErrors, setFieldErrors] = useState<ProjectApiError['fields']>({});

  const load = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try {
      const response = await fetch('/api/projects', { headers: { Accept: 'application/json' } });
      if (!response.ok) throw new Error();
      const body = (await response.json()) as { data: WorkspaceProject[] };
      setProjects(body.data);
    } catch {
      setError('Watchrail could not load projects. Check that the API and database are running.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  const visibleProjects = useMemo(() => {
    const term = query.trim().toLocaleLowerCase();
    return term
      ? projects.filter((project) => project.name.toLocaleLowerCase().includes(term))
      : projects;
  }, [projects, query]);

  async function createProject(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setError(undefined);
    setFieldErrors({});
    const form = new FormData(event.currentTarget);
    try {
      const response = await fetch('/api/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ name: form.get('name'), slug: form.get('slug') }),
      });
      const body = (await response.json()) as { data?: WorkspaceProject } & ProjectApiError;
      if (!response.ok || !body.data) {
        setFieldErrors(body.fields ?? {});
        setError(body.message ?? 'Watchrail could not create this project.');
        return;
      }
      router.push(`/projects/${body.data.id}`);
    } catch {
      setError('Watchrail could not reach the API. Try again.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <AppShell page="projects" workspaceId={workspaceId}>
      <main id="main-content" data-watchrail-workspace className="w-full min-w-0 pb-16">
        <PageHeader
          title="Projects"
          description="Keep each product’s monitors, incidents, and public status separate."
          actions={
            <Button variant="primary" onClick={() => setCreating(true)}>
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
              New project
            </Button>
          }
        />

        <div className="mt-6 flex max-w-md items-center gap-2 rounded-rail-control border border-rail-border bg-rail-surface px-3 focus-within:border-rail-accent">
          <svg
            viewBox="0 0 20 20"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            className="size-4 text-rail-muted"
            aria-hidden="true"
          >
            <circle cx="8.5" cy="8.5" r="5.5" />
            <path d="m13 13 4 4" />
          </svg>
          <label htmlFor="project-search" className="sr-only">
            Search projects
          </label>
          <input
            id="project-search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search projects"
            className="min-h-10 min-w-0 flex-1 border-0 bg-transparent text-sm text-rail-text outline-none placeholder:text-rail-muted focus-visible:!outline-none"
          />
        </div>

        {loading ? (
          <div className="mt-6 grid min-h-48 place-items-center border-y border-rail-border text-sm text-rail-muted">
            Loading projects…
          </div>
        ) : error ? (
          <div className="mt-6 grid min-h-48 place-items-center border-y border-rail-border py-10 text-center">
            <div>
              <p className="m-0 text-sm text-rail-danger" role="alert">
                {error}
              </p>
              <Button className="mt-4" variant="secondary" onClick={() => void load()}>
                Try again
              </Button>
            </div>
          </div>
        ) : visibleProjects.length === 0 ? (
          <div className="mt-6 border-y border-rail-border py-14 text-center">
            <h2 className="m-0 text-base font-medium text-rail-text">
              {projects.length === 0 ? 'Create your first project' : 'No projects match'}
            </h2>
            <p className="mx-auto mt-2 mb-0 max-w-md text-sm text-rail-subtle">
              {projects.length === 0
                ? 'A project keeps one product’s monitoring data and status pages together.'
                : 'Try a different project name.'}
            </p>
          </div>
        ) : (
          <ul className="mt-6 grid list-none gap-px overflow-hidden rounded-rail-panel border border-rail-border bg-rail-border p-0 sm:grid-cols-2 xl:grid-cols-3">
            {visibleProjects.map((project) => (
              <li key={project.id} className="bg-rail-surface">
                <Link
                  href={`/projects/${project.id}`}
                  className="group block min-h-36 p-5 text-rail-text no-underline transition-colors hover:bg-rail-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-rail-accent"
                >
                  <div className="flex items-start justify-between gap-4">
                    <h2 className="m-0 truncate text-sm font-semibold">{project.name}</h2>
                    <svg
                      viewBox="0 0 16 16"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.5"
                      className="size-4 text-rail-muted transition-transform group-hover:translate-x-0.5 motion-reduce:transition-none"
                      aria-hidden="true"
                    >
                      <path d="m6 3 5 5-5 5" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  </div>
                  <p className="mt-2 mb-0 text-xs text-rail-muted">
                    {project.monitorCount === 1 ? '1 monitor' : `${project.monitorCount} monitors`}
                  </p>
                  <p className="mt-8 mb-0 truncate text-xs text-rail-subtle">/{project.slug}</p>
                </Link>
              </li>
            ))}
          </ul>
        )}

        {creating ? (
          <div
            className="fixed inset-0 z-[90] grid place-items-center bg-black/65 px-4"
            role="presentation"
            onMouseDown={(event) => {
              if (event.target === event.currentTarget) setCreating(false);
            }}
          >
            <Form
              onSubmit={createProject}
              className="w-full max-w-md rounded-rail-panel border border-rail-border bg-rail-overlay p-5 shadow-[0_24px_80px_var(--color-rail-shadow)]"
              aria-labelledby="create-project-title"
            >
              <h2 id="create-project-title" className="m-0 text-base font-semibold text-rail-text">
                Create project
              </h2>
              <p className="mt-1 mb-5 text-sm text-rail-subtle">
                Use one project for each product or customer-facing service.
              </p>
              <label className="grid gap-1.5 text-xs font-medium text-rail-subtle">
                Project name
                <Input name="name" required maxLength={120} autoFocus />
              </label>
              {fieldErrors?.name?.[0] ? (
                <p className="mt-1 text-xs text-rail-danger">{fieldErrors.name[0]}</p>
              ) : null}
              <label className="mt-4 grid gap-1.5 text-xs font-medium text-rail-subtle">
                URL slug{' '}
                <span className="font-normal text-rail-muted">
                  Optional—generated from the name
                </span>
                <Input name="slug" maxLength={63} />
              </label>
              {fieldErrors?.slug?.[0] ? (
                <p className="mt-1 text-xs text-rail-danger">{fieldErrors.slug[0]}</p>
              ) : null}
              <div className="mt-6 flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setCreating(false)}
                  className={actionClassName({ variant: 'quiet' })}
                >
                  Cancel
                </button>
                <Button type="submit" variant="primary" disabled={submitting}>
                  {submitting ? 'Creating…' : 'Create project'}
                </Button>
              </div>
            </Form>
          </div>
        ) : null}
      </main>
    </AppShell>
  );
}
