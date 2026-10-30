import type {
  PublicStatusPageIncidentV1,
  PublicStatusPageProjectionV1,
  PublicStatusState,
} from '@watchrail/domain';
import Link from 'next/link';
import { StatusHistory } from './status-history';
import { StatusPageFooter, StatusPageHeader } from './status-page-chrome';

const labels: Record<PublicStatusState, string> = {
  OPERATIONAL: 'Operational',
  PARTIAL_OUTAGE: 'Partial outage',
  MAJOR_OUTAGE: 'Major outage',
  MONITORING_IMPAIRED: 'Status unavailable',
};

export function publicStatusLabel(status: PublicStatusState): string {
  if (status === 'OPERATIONAL') return 'All systems operational';
  return labels[status];
}

function statusHeadline(status: PublicStatusState): string {
  if (status === 'OPERATIONAL') return 'All services operational';
  if (status === 'PARTIAL_OUTAGE') return 'Some services are degraded';
  if (status === 'MAJOR_OUTAGE') return 'Service disruption detected';
  return 'Service status unavailable';
}

export function StatusPageView({ page }: { page: PublicStatusPageProjectionV1 }) {
  const names = new Map(page.components.map((component) => [component.id, component.displayName]));
  return (
    <main data-watchrail-workspace className="min-h-svh w-full bg-rail-canvas text-rail-text">
      <div className="mx-auto w-full max-w-[760px] px-4 pb-20 sm:px-6">
        <StatusPageHeader page={page} active="status" />

        <section
          id="current-status"
          className="scroll-mt-6 py-14 text-center sm:py-16"
          aria-live="polite"
        >
          <span
            className={`mx-auto grid size-9 place-items-center rounded-full border ${stateSurfaceClass(page.status)}`}
            aria-hidden="true"
          >
            <StatusIcon status={page.status} />
          </span>
          <h1 className="mt-5 mb-0 text-2xl font-semibold tracking-[-0.025em] text-rail-text sm:text-[28px]">
            {statusHeadline(page.status)}
          </h1>
          <p className="mt-2 mb-0 text-xs text-rail-muted">
            Last updated <time dateTime={page.generatedAt}>{formatUtc(page.generatedAt)}</time>
          </p>
        </section>

        <StatusHistory
          slug={page.slug}
          components={page.components}
          activeIncidents={page.activeIncidents}
          resolvedIncidents={page.resolvedIncidents}
          generatedAt={page.generatedAt}
        />

        {page.activeIncidents.length > 0 ? (
          <IncidentSection
            title="Active incidents"
            description="Current service interruptions and investigations."
            incidents={page.activeIncidents}
            names={names}
            slug={page.slug}
            active
          />
        ) : null}

        <StatusPageFooter />
      </div>
    </main>
  );
}

function IncidentSection({
  title,
  description,
  incidents,
  names,
  slug,
  active = false,
}: {
  title: string;
  description: string;
  incidents: PublicStatusPageIncidentV1[];
  names: Map<string, string>;
  slug: string;
  active?: boolean;
}) {
  const id = title.toLowerCase().replaceAll(' ', '-');
  return (
    <section id={id} className="scroll-mt-6 pt-10" aria-labelledby={`${id}-heading`}>
      <div className="mb-4">
        <h2 id={`${id}-heading`} className="m-0 text-base font-semibold text-rail-text">
          {title}
        </h2>
        <p className="mt-1 mb-0 text-sm text-rail-subtle">{description}</p>
      </div>
      <div className="overflow-hidden rounded-rail-panel border border-rail-border bg-rail-surface">
        {incidents.length === 0 ? (
          <p className="m-0 px-4 py-6 text-sm text-rail-subtle sm:px-5">No incidents reported.</p>
        ) : (
          <ol data-ui="incident-list" className="m-0 grid list-none gap-px bg-rail-border p-0">
            {incidents.map((incident) => (
              <li
                key={incident.id}
                className="grid gap-2 bg-rail-surface px-4 py-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center sm:px-5"
              >
                <div className="min-w-0">
                  <h3 className="m-0 truncate text-sm font-medium text-rail-text">
                    <Link
                      href={`/status/${encodeURIComponent(slug)}/incidents/${incident.id}`}
                      className="text-rail-text no-underline hover:underline hover:underline-offset-4"
                    >
                      {names.get(incident.componentId) ?? 'Service incident'}
                    </Link>
                  </h3>
                  <p className="mt-1 mb-0 text-xs text-rail-muted">
                    {active ? 'Investigation in progress' : 'Service recovered'}
                  </p>
                </div>
                <p className="m-0 text-xs tabular-nums text-rail-subtle sm:text-right">
                  {active ? 'Started ' : ''}
                  <time dateTime={incident.startedAt}>{formatUtc(incident.startedAt)}</time>
                  {!active && incident.resolvedAt ? (
                    <>
                      {' to '}
                      <time dateTime={incident.resolvedAt}>{formatUtc(incident.resolvedAt)}</time>
                    </>
                  ) : null}
                </p>
              </li>
            ))}
          </ol>
        )}
      </div>
    </section>
  );
}

function StatusIcon({ status }: { status: PublicStatusState }) {
  if (status === 'OPERATIONAL') {
    return (
      <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2" className="size-4">
        <path d="m5.5 10 3 3 6-6" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8" className="size-4">
      <path d="M10 5.5v5" strokeLinecap="round" />
      <path d="M10 14.5h.01" strokeLinecap="round" />
    </svg>
  );
}

function stateSurfaceClass(status: PublicStatusState): string {
  if (status === 'OPERATIONAL')
    return 'border-rail-success/35 bg-rail-success/10 text-rail-success';
  if (status === 'PARTIAL_OUTAGE') {
    return 'border-rail-warning/35 bg-rail-warning/10 text-rail-warning';
  }
  if (status === 'MAJOR_OUTAGE') return 'border-rail-danger/35 bg-rail-danger/10 text-rail-danger';
  return 'border-rail-impaired/35 bg-rail-impaired/10 text-rail-impaired';
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
