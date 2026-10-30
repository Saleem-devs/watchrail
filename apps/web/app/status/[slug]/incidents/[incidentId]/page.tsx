import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import Link from 'next/link';
import { loadPublicStatusPage } from '../../../../../lib/public-status-page';
import { StatusPageFooter, StatusPageHeader } from '../../status-page-chrome';
import { StatusPageRefresh } from '../../status-page-refresh';

export const dynamic = 'force-dynamic';
type Props = { params: Promise<{ slug: string; incidentId: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug, incidentId } = await params;
  const page = await loadPublicStatusPage(slug);
  const incident = page
    ? [...page.activeIncidents, ...page.resolvedIncidents].find(({ id }) => id === incidentId)
    : undefined;
  if (!page || !incident) {
    return { title: 'Incident not found · Watchrail', robots: { index: false } };
  }
  const component = page.components.find(({ id }) => id === incident.componentId);
  return { title: `${incidentTitle(component?.displayName, incident.severity)} · ${page.name}` };
}

export default async function PublicIncidentPage({ params }: Props) {
  const { slug, incidentId } = await params;
  const page = await loadPublicStatusPage(slug);
  if (!page) notFound();
  const incident = [...page.activeIncidents, ...page.resolvedIncidents].find(
    ({ id }) => id === incidentId,
  );
  if (!incident) notFound();
  const component = page.components.find(({ id }) => id === incident.componentId);
  const componentName = component?.displayName ?? 'Service';
  const title = incidentTitle(componentName, incident.severity);
  const incidentsHref = `/status/${encodeURIComponent(page.slug)}/incidents`;

  return (
    <main data-watchrail-workspace className="min-h-svh w-full bg-rail-canvas text-rail-text">
      <div className="mx-auto w-full max-w-[760px] px-4 pb-20 sm:px-6">
        <StatusPageHeader page={page} active="incidents" />
        <article className="py-10 sm:py-12">
          <Link
            href={incidentsHref}
            className="inline-flex min-h-9 items-center gap-2 rounded-rail-control text-xs font-medium text-rail-subtle no-underline hover:text-rail-text focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-rail-accent"
          >
            <BackIcon />
            Incidents
          </Link>

          <header className="mt-6">
            <h1 className="m-0 text-2xl font-semibold tracking-[-0.025em] text-rail-text">
              {title}
            </h1>
            <p className="mt-2 mb-0 text-sm text-rail-subtle">
              Started <time dateTime={incident.startedAt}>{formatUtc(incident.startedAt)}</time>
              {incident.resolvedAt ? (
                <>
                  {' · Resolved '}
                  <time dateTime={incident.resolvedAt}>{formatUtc(incident.resolvedAt)}</time>
                </>
              ) : null}
            </p>
            <span
              className={`mt-4 inline-flex min-h-6 items-center gap-1.5 rounded-full border px-2.5 text-xs font-medium ${incident.status === 'OPEN' ? 'border-rail-danger/30 bg-rail-danger/10 text-rail-danger' : 'border-rail-success/30 bg-rail-success/10 text-rail-success'}`}
            >
              <span
                className={`size-1.5 rounded-full ${incident.status === 'OPEN' ? 'bg-rail-danger' : 'bg-rail-success'}`}
              />
              {incident.status === 'OPEN' ? 'Active' : 'Resolved'}
            </span>
          </header>

          <section
            data-ui="incident-detail"
            className="mt-8 grid gap-px overflow-hidden rounded-rail-panel bg-rail-border p-px"
            aria-labelledby="affected-heading"
          >
            <div className="bg-rail-surface px-4 py-4 sm:px-5">
              <h2 id="affected-heading" className="m-0 text-sm font-semibold text-rail-text">
                Affected service
              </h2>
            </div>
            <div className="flex items-center justify-between gap-4 bg-rail-surface px-4 py-5 sm:px-5">
              <span className="text-sm text-rail-text">{componentName}</span>
              <span
                className={`text-xs font-medium ${incident.severity === 'DOWN' ? 'text-rail-danger' : 'text-rail-warning'}`}
              >
                {incident.severity === 'DOWN' ? 'Unavailable' : 'Degraded'}
              </span>
            </div>
          </section>

          <section
            data-ui="incident-timeline"
            className="mt-6 grid gap-px overflow-hidden rounded-rail-panel bg-rail-border p-px"
            aria-labelledby="updates-heading"
          >
            <div className="bg-rail-surface px-4 py-4 sm:px-5">
              <h2 id="updates-heading" className="m-0 text-sm font-semibold text-rail-text">
                Updates
              </h2>
            </div>
            <ol className="m-0 grid list-none gap-px bg-rail-border p-0">
              {incident.resolvedAt ? (
                <li className="grid gap-2 bg-rail-surface px-4 py-5 sm:grid-cols-[minmax(0,1fr)_auto] sm:px-5">
                  <div>
                    <h3 className="m-0 text-sm font-medium text-rail-text">Resolved</h3>
                    <p className="mt-1 mb-0 text-sm text-rail-subtle">
                      Monitoring recorded the service as recovered.
                    </p>
                  </div>
                  <time
                    className="text-xs tabular-nums text-rail-muted"
                    dateTime={incident.resolvedAt}
                  >
                    {formatUtc(incident.resolvedAt)}
                  </time>
                </li>
              ) : null}
              <li className="grid gap-2 bg-rail-surface px-4 py-5 sm:grid-cols-[minmax(0,1fr)_auto] sm:px-5">
                <div>
                  <h3 className="m-0 text-sm font-medium text-rail-text">Detected</h3>
                  <p className="mt-1 mb-0 text-sm text-rail-subtle">
                    Monitoring detected{' '}
                    {incident.severity === 'DOWN' ? 'an outage' : 'degraded availability'} for{' '}
                    {componentName}.
                  </p>
                </div>
                <time
                  className="text-xs tabular-nums text-rail-muted"
                  dateTime={incident.startedAt}
                >
                  {formatUtc(incident.startedAt)}
                </time>
              </li>
            </ol>
          </section>
        </article>
        <StatusPageFooter />
      </div>
      <StatusPageRefresh />
    </main>
  );
}

function BackIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      className="size-3.5"
      aria-hidden="true"
    >
      <path d="m10 4-4 4 4 4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
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
