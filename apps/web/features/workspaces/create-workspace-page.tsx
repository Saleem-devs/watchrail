'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { AppShell } from '../../components/app-shell';
import { actionClassName, Button } from '../../components/ui/button';
import { Input } from '../../components/ui/form-control';
import { PageHeader } from '../../components/ui/page-header';
import { authClient } from '../../lib/auth-client';

function workspaceSlug(name: string): string {
  return name
    .normalize('NFKD')
    .toLocaleLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63);
}

export function CreateWorkspacePage() {
  const router = useRouter();
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [slugEdited, setSlugEdited] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string>();

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setError(undefined);
    const result = await authClient.organization.create({ name: name.trim(), slug: slug.trim() });
    if (result.error || !result.data) {
      setError(result.error?.message ?? 'Watchrail could not create this workspace.');
      setSubmitting(false);
      return;
    }
    const activated = await authClient.organization.setActive({ organizationId: result.data.id });
    if (activated.error) {
      setError('The workspace was created, but Watchrail could not open it.');
      setSubmitting(false);
      return;
    }
    router.push(`/workspaces/${result.data.id}`);
    router.refresh();
  }

  return (
    <AppShell page="workspaces">
      <main id="main-content" data-watchrail-workspace className="w-full min-w-0 pb-16">
        <PageHeader
          title="Create workspace"
          description="Create a separate home for projects, members, and access settings."
          backLink={{ href: '/workspaces', label: 'Back to workspaces' }}
          actions={
            <>
              <Link href="/workspaces" className={actionClassName({ variant: 'quiet' })}>
                Cancel
              </Link>
              <Button
                type="submit"
                form="create-workspace-form"
                variant="primary"
                disabled={submitting}
              >
                {submitting ? 'Creating…' : 'Create workspace'}
              </Button>
            </>
          }
        />

        <form
          id="create-workspace-form"
          onSubmit={submit}
          className="mt-6 max-w-2xl overflow-hidden rounded-rail-panel border border-rail-border bg-rail-surface"
        >
          <section className="p-5 sm:p-6">
            <h2 className="m-0 text-sm font-semibold text-rail-text">Workspace details</h2>
            <p className="mt-1 mb-5 text-xs leading-5 text-rail-muted">
              Choose a recognizable name and stable URL slug.
            </p>
            <div className="grid gap-5">
              <label className="grid gap-1.5 text-xs font-medium text-rail-subtle">
                Workspace name
                <Input
                  name="name"
                  required
                  minLength={2}
                  maxLength={120}
                  autoFocus
                  value={name}
                  placeholder="Neyo"
                  onChange={(event) => {
                    const nextName = event.target.value;
                    setName(nextName);
                    if (!slugEdited) setSlug(workspaceSlug(nextName));
                  }}
                />
                <span className="font-normal text-rail-muted">
                  Enter the name only. Watchrail does not add “Workspace” to custom names.
                </span>
              </label>
              <label className="grid gap-1.5 text-xs font-medium text-rail-subtle">
                URL slug
                <Input
                  name="slug"
                  required
                  minLength={2}
                  maxLength={63}
                  pattern="[a-z0-9]+(?:-[a-z0-9]+)*"
                  value={slug}
                  placeholder="engineering"
                  onChange={(event) => {
                    setSlugEdited(true);
                    setSlug(workspaceSlug(event.target.value));
                  }}
                />
                <span className="font-normal text-rail-muted">
                  Lowercase letters, numbers, and hyphens only.
                </span>
              </label>
            </div>
          </section>
          {error ? (
            <p
              role="alert"
              className="m-0 border-t border-rail-border px-5 py-4 text-sm text-rail-danger sm:px-6"
            >
              {error}
            </p>
          ) : null}
        </form>
      </main>
    </AppShell>
  );
}
