'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState, type FormEvent } from 'react';
import { AppShell } from '../../components/app-shell';
import { actionClassName, Button } from '../../components/ui/button';
import { Checkbox, Input, Select, Textarea } from '../../components/ui/form-control';
import { PageHeader } from '../../components/ui/page-header';
import { apiErrorMessage, loadStatusPage } from './status-page-api';
import type { StatusPageApiError, WorkspaceStatusPage, WorkspaceStatusPageIncident } from './types';

export function StatusPageIncidentForm({
  projectId,
  statusPageId,
}: {
  projectId: string;
  statusPageId: string;
}) {
  const router = useRouter();
  const base = `/projects/${projectId}/status-pages/${statusPageId}`;
  const formId = 'status-page-incident-form';
  const [page, setPage] = useState<WorkspaceStatusPage>();
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string>();
  const [title, setTitle] = useState('');
  const [impact, setImpact] = useState<'DEGRADED' | 'DOWN'>('DEGRADED');
  const [message, setMessage] = useState('');
  const [componentIds, setComponentIds] = useState<string[]>([]);

  useEffect(() => {
    let cancelled = false;
    void loadStatusPage(statusPageId)
      .then((loaded) => {
        if (!cancelled) setPage(loaded);
      })
      .catch((loadError: unknown) => {
        if (!cancelled) {
          setError(loadError instanceof Error ? loadError.message : 'Could not load status page.');
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [statusPageId]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (componentIds.length === 0) {
      setError('Select at least one affected component.');
      return;
    }
    setSubmitting(true);
    setError(undefined);
    try {
      const response = await fetch(`/api/status-pages/${statusPageId}/incidents`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ title, impact, message, componentIds }),
      });
      const body = (await response.json()) as {
        data?: WorkspaceStatusPageIncident;
      } & StatusPageApiError;
      if (!response.ok || !body.data) {
        throw new Error(apiErrorMessage(body, 'Could not create incident.'));
      }
      router.push(`${base}/incidents/${body.data.id}`);
      router.refresh();
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : 'Could not create incident.');
      setSubmitting(false);
    }
  }

  return (
    <AppShell page="status-pages" projectId={projectId}>
      <main id="main-content" data-watchrail-workspace className="w-full min-w-0 pb-16">
        <PageHeader
          title="Create incident"
          description="Publish an operator-led incident without changing monitor health or uptime."
          backLink={{ href: base, label: 'Back to status page' }}
          actions={
            !loading && page ? (
              <>
                <Link href={base} className={actionClassName({ variant: 'quiet' })}>
                  Cancel
                </Link>
                <Button type="submit" form={formId} variant="primary" disabled={submitting}>
                  {submitting ? 'Publishing…' : 'Publish incident'}
                </Button>
              </>
            ) : undefined
          }
        />

        {loading ? (
          <div className="grid min-h-64 place-items-center text-sm text-rail-muted" role="status">
            Loading status-page components…
          </div>
        ) : !page ? (
          <p
            className="mt-6 rounded-rail-panel border border-rail-border bg-rail-surface p-5 text-sm text-rail-subtle"
            role="alert"
          >
            {error ?? 'Status page unavailable.'}
          </p>
        ) : (
          <form id={formId} className="mt-6" onSubmit={submit} aria-busy={submitting}>
            <div className="overflow-hidden rounded-rail-panel border border-rail-border bg-rail-surface">
              <section className="p-5 sm:p-6" aria-labelledby="incident-details">
                <h2 id="incident-details" className="m-0 text-base font-medium text-rail-text">
                  Incident details
                </h2>
                <p className="mt-1 mb-5 text-sm text-rail-subtle">
                  Start with what customers need to know now. The first update is marked
                  Investigating.
                </p>
                <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_16rem]">
                  <label className="grid gap-2 text-sm font-medium text-rail-text">
                    Title
                    <Input
                      required
                      maxLength={160}
                      value={title}
                      onChange={(event) => setTitle(event.target.value)}
                      placeholder="Checkout requests are failing"
                    />
                  </label>
                  <label className="grid gap-2 text-sm font-medium text-rail-text">
                    Customer impact
                    <Select
                      value={impact}
                      onChange={(event) => setImpact(event.target.value as 'DEGRADED' | 'DOWN')}
                    >
                      <option value="DEGRADED">Degraded performance</option>
                      <option value="DOWN">Major outage</option>
                    </Select>
                  </label>
                </div>
                <label className="mt-4 grid gap-2 text-sm font-medium text-rail-text">
                  First update
                  <Textarea
                    required
                    maxLength={2000}
                    rows={5}
                    value={message}
                    onChange={(event) => setMessage(event.target.value)}
                    placeholder="We are investigating elevated failures and will share another update shortly."
                  />
                  <span className="text-xs font-normal text-rail-muted">
                    Published with the Investigating state.
                  </span>
                </label>
              </section>

              <section
                className="border-t border-rail-border p-5 sm:p-6"
                aria-labelledby="affected-components"
              >
                <h2 id="affected-components" className="m-0 text-base font-medium text-rail-text">
                  Affected components
                </h2>
                <p className="mt-1 mb-4 text-sm text-rail-subtle">
                  Choose the customer-facing services this incident affects.
                </p>
                {page.components.length === 0 ? (
                  <p className="m-0 text-sm text-rail-muted">
                    Add public components before creating an incident.
                  </p>
                ) : (
                  <div className="grid gap-px overflow-hidden rounded-rail-control border border-rail-border bg-rail-border sm:grid-cols-2">
                    {[...page.components]
                      .sort((left, right) => left.position - right.position)
                      .map((component) => {
                        const checked = componentIds.includes(component.id);
                        return (
                          <label
                            key={component.id}
                            className="flex min-h-14 cursor-pointer items-center gap-3 bg-rail-surface px-4 py-3 text-sm text-rail-text hover:bg-rail-hover"
                          >
                            <Checkbox
                              checked={checked}
                              onChange={() =>
                                setComponentIds((current) =>
                                  checked
                                    ? current.filter((id) => id !== component.id)
                                    : [...current, component.id],
                                )
                              }
                            />
                            <span>{component.displayName}</span>
                          </label>
                        );
                      })}
                  </div>
                )}
              </section>
            </div>
            {error ? (
              <p
                className="mt-4 rounded-rail-control border border-rail-danger/30 bg-rail-danger/8 px-4 py-3 text-sm text-rail-danger"
                role="alert"
              >
                {error}
              </p>
            ) : null}
          </form>
        )}
      </main>
    </AppShell>
  );
}
