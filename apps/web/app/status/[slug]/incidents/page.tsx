import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import Link from 'next/link';
import { loadPublicStatusPage } from '../../../../lib/public-status-page';
import { StatusPageFooter, StatusPageHeader } from '../status-page-chrome';
import { StatusPageRefresh } from '../status-page-refresh';

export const dynamic = 'force-dynamic';
type Props = { params: Promise<{ slug: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const page = await loadPublicStatusPage(slug);
  if (!page) return { title: 'Status page not found · Watchrail', robots: { index: false } };
  return { title: `Incidents · ${page.name}` };
}

export default async function PublicIncidentsPage({ params }: Props) {
  const { slug } = await params;
  const page = await loadPublicStatusPage(slug);
  if (!page) notFound();
  const names = new Map(page.components.map((component) => [component.id, component.displayName]));
  const incidents = [...page.activeIncidents, ...page.resolvedIncidents].sort(
    (left, right) => new Date(right.startedAt).getTime() - new Date(left.startedAt).getTime(),
  );
  const groups = groupByMonth(incidents);

  return (
    <main data-watchrail-workspace className="min-h-svh w-full bg-rail-canvas text-rail-text">
      <div className="mx-auto w-full max-w-[760px] px-4 pb-20 sm:px-6">
        <StatusPageHeader page={page} active="incidents" />
        <section className="py-10 sm:py-12" aria-labelledby="incidents-heading">
          <h1
            id="incidents-heading"
            className="m-0 text-2xl font-semibold tracking-[-0.025em] text-rail-text"
          >
            Incidents
          </h1>
          <p className="mt-2 mb-0 text-sm text-rail-subtle">
            Service interruptions reported during the past 90 days.
          </p>
        </section>

        {groups.length === 0 ? (
          <div className="rounded-rail-panel border border-rail-border bg-rail-surface px-5 py-10 text-center">
            <h2 className="m-0 text-base font-medium text-rail-text">No incidents reported</h2>
            <p className="mt-2 mb-0 text-sm text-rail-subtle">
              There are no active or resolved incidents in the reporting window.
            </p>
          </div>
        ) : (
          <div className="grid gap-9">
            {groups.map((group) => (
              <section key={group.label} aria-labelledby={`month-${group.key}`}>
                <h2 id={`month-${group.key}`} className="mb-3 text-sm font-semibold text-rail-text">
                  {group.label}
                </h2>
                <ol
                  data-ui="incident-list"
                  className="m-0 grid list-none gap-px overflow-hidden rounded-rail-panel bg-rail-border p-px"
                >
                  {group.incidents.map((incident) => (
                    <li key={incident.id}>
                      <Link
                        href={`/status/${encodeURIComponent(page.slug)}/incidents/${incident.id}`}
                        className="grid min-h-24 gap-3 bg-rail-surface px-4 py-4 text-rail-text no-underline hover:bg-rail-hover focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-rail-accent sm:grid-cols-[minmax(0,1fr)_auto] sm:px-5"
                      >
                        <span className="min-w-0">
                          <span className="flex items-center gap-2 text-sm font-medium">
                            <span
                              className={`size-2 rounded-full ${incident.status === 'OPEN' ? 'bg-rail-danger' : 'bg-rail-success'}`}
                            />
                            {incidentTitle(names.get(incident.componentId), incident.severity)}
                          </span>
                          <span className="mt-2 block text-sm text-rail-subtle">
                            {incident.status === 'OPEN'
                              ? 'This interruption is active.'
                              : 'The service recovered.'}
                          </span>
                          <span className="mt-1 block text-xs text-rail-muted">
                            Affects {names.get(incident.componentId) ?? 'service'}
                          </span>
                        </span>
                        <span className="text-xs tabular-nums text-rail-muted sm:text-right">
                          {incident.status === 'OPEN' ? 'Started ' : 'Resolved '}
                          <time dateTime={incident.resolvedAt ?? incident.startedAt}>
                            {formatUtc(incident.resolvedAt ?? incident.startedAt)}
                          </time>
                        </span>
                      </Link>
                    </li>
                  ))}
                </ol>
              </section>
            ))}
          </div>
        )}
        <StatusPageFooter />
      </div>
      <StatusPageRefresh />
    </main>
  );
}

function groupByMonth<T extends { startedAt: string }>(incidents: T[]) {
  const groups = new Map<string, { key: string; label: string; incidents: T[] }>();
  for (const incident of incidents) {
    const date = new Date(incident.startedAt);
    const key = `${date.getUTCFullYear()}-${date.getUTCMonth()}`;
    const group = groups.get(key) ?? {
      key,
      label: new Intl.DateTimeFormat('en-GB', {
        month: 'long',
        year: 'numeric',
        timeZone: 'UTC',
      }).format(date),
      incidents: [],
    };
    group.incidents.push(incident);
    groups.set(key, group);
  }
  return [...groups.values()];
}

function incidentTitle(
  componentName: string | undefined,
  severity: 'DEGRADED' | 'DOWN' | undefined,
): string {
  const name = componentName ?? 'Service';
  return severity === 'DEGRADED' ? `${name} degraded` : `${name} unavailable`;
}

function formatUtc(value: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: 'UTC',
    timeZoneName: 'short',
  }).format(new Date(value));
}
