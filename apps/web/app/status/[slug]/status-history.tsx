import type {
  PublicStatusPageComponentV1,
  PublicStatusPageIncidentV1,
  PublicStatusState,
} from '@watchrail/domain';
import Link from 'next/link';

const DAY_COUNT = 30;
const DAY_MS = 86_400_000;

interface DayAvailability {
  monitored: boolean;
  measuredDurationMs: number;
  degradedRatio: number;
  downRatio: number;
  incidents: PublicStatusPageIncidentV1[];
}

interface UptimeMeasurement {
  measuredDurationMs: number;
  unavailableDurationMs: number;
}

export function StatusHistory({
  slug,
  components,
  activeIncidents,
  resolvedIncidents,
  generatedAt,
}: {
  slug: string;
  components: PublicStatusPageComponentV1[];
  activeIncidents: PublicStatusPageIncidentV1[];
  resolvedIncidents: PublicStatusPageIncidentV1[];
  generatedAt: string;
}) {
  const generated = new Date(generatedAt);
  const today = startOfUtcDay(generated);
  const days = Array.from({ length: DAY_COUNT }, (_, index) => {
    const start = new Date(today.getTime() - (DAY_COUNT - 1 - index) * DAY_MS);
    return { start, end: new Date(start.getTime() + DAY_MS) };
  });
  const incidents = [...activeIncidents, ...resolvedIncidents];
  const groups = groupComponents(components);
  const rangeStart = days[0]?.start.getTime() ?? today.getTime();
  const rangeEnd = generated.getTime();

  return (
    <section className="pt-10" aria-labelledby="services-heading">
      <div className="mb-4 flex items-end justify-between gap-4">
        <div>
          <h2 id="services-heading" className="m-0 text-base font-semibold text-rail-text">
            Services
          </h2>
          <p className="mt-1 mb-0 text-sm text-rail-subtle">
            Current state and measured availability over the past 30 days.
          </p>
        </div>
        <span className="hidden text-xs text-rail-muted sm:block">30 days</span>
      </div>

      {components.length === 0 ? (
        <div className="rounded-rail-panel border border-rail-border bg-rail-surface px-4 py-6 text-sm text-rail-subtle sm:px-5">
          No public services are configured.
        </div>
      ) : (
        <div data-ui="status-history" className="grid gap-px bg-rail-border">
          {groups.map((group) => {
            const groupStatus = deriveGroupStatus(group.components);
            const groupUptime = combineUptimeMeasurements(
              group.components.map((component) =>
                measureUptime(
                  component.monitoringStartedAt,
                  incidents.filter((incident) => incident.componentId === component.id),
                  rangeStart,
                  rangeEnd,
                ),
              ),
            );
            return (
              <details key={group.name} open className="group/status bg-rail-canvas py-1">
                <summary className="flex min-h-12 cursor-pointer list-none items-center justify-between gap-4 rounded-rail-control px-1 text-sm font-medium text-rail-text outline-none hover:text-rail-subtle focus-visible:ring-2 focus-visible:ring-rail-accent [&::-webkit-details-marker]:hidden">
                  <span className="inline-flex min-w-0 items-center gap-2">
                    <StatusIcon status={groupStatus} />
                    <span className="sr-only">Current status: {stateLabel(groupStatus)}.</span>
                    <span className="truncate">{group.name}</span>
                    <ChevronIcon />
                  </span>
                  <span className="shrink-0 text-xs tabular-nums text-rail-subtle">
                    {formatUptime(groupUptime, true)}
                  </span>
                </summary>
                <ul className="m-0 list-none p-0">
                  {group.components.map((component) => {
                    const componentIncidents = incidents.filter(
                      (incident) => incident.componentId === component.id,
                    );
                    const componentUptime = measureUptime(
                      component.monitoringStartedAt,
                      componentIncidents,
                      rangeStart,
                      rangeEnd,
                    );
                    return (
                      <li key={component.id} className="mt-px bg-rail-canvas py-4">
                        <div className="mb-3 flex items-center justify-between gap-4 px-1">
                          <span className="inline-flex min-w-0 items-center gap-2 text-sm text-rail-text">
                            <StatusIcon status={component.status} />
                            <span className="sr-only">
                              Current status: {stateLabel(component.status)}.
                            </span>
                            <span className="truncate">{component.displayName}</span>
                          </span>
                          <span className="shrink-0 text-xs font-medium tabular-nums text-rail-subtle">
                            {formatUptime(componentUptime)}
                          </span>
                        </div>
                        <div
                          className="grid grid-cols-[repeat(30,minmax(3px,1fr))] gap-1 px-1"
                          role="list"
                        >
                          {days.map((day) => {
                            const availability = dayAvailability(
                              day,
                              component.monitoringStartedAt,
                              componentIncidents,
                              generated,
                            );
                            const label = dayLabel(day.start, availability);
                            const incident = availability.incidents[0];
                            const cell = <DayCell availability={availability} />;
                            const className =
                              'group/day relative block rounded-[2px] outline-none focus-visible:ring-2 focus-visible:ring-rail-accent focus-visible:ring-offset-2 focus-visible:ring-offset-rail-canvas';
                            return incident ? (
                              <Link
                                key={day.start.toISOString()}
                                href={`/status/${encodeURIComponent(slug)}/incidents/${incident.id}`}
                                role="listitem"
                                aria-label={`${label}. View incident.`}
                                className={className}
                              >
                                {cell}
                                <DayTooltip label={label} action="View incident" />
                              </Link>
                            ) : (
                              <span
                                key={day.start.toISOString()}
                                role="listitem"
                                tabIndex={0}
                                aria-label={label}
                                className={className}
                              >
                                {cell}
                                <DayTooltip label={label} />
                              </span>
                            );
                          })}
                        </div>
                        <div className="mt-2 flex justify-between px-1 text-xs text-rail-muted">
                          <time dateTime={days[0]?.start.toISOString()}>
                            {days[0] ? formatDate(days[0].start) : ''}
                          </time>
                          <span>Today</span>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </details>
            );
          })}
        </div>
      )}
    </section>
  );
}

function DayCell({ availability }: { availability: DayAvailability }) {
  return (
    <span
      aria-hidden="true"
      className={`relative block h-8 overflow-hidden rounded-[2px] ${availability.monitored ? 'bg-rail-success' : 'bg-rail-border-strong'}`}
    >
      {availability.degradedRatio > 0 ? (
        <span
          className="absolute inset-x-0 bottom-0 bg-rail-warning"
          style={{ height: incidentVisualHeight(availability.degradedRatio) }}
        />
      ) : null}
      {availability.downRatio > 0 ? (
        <span
          className="absolute inset-x-0 bottom-0 bg-rail-danger"
          style={{ height: incidentVisualHeight(availability.downRatio) }}
        />
      ) : null}
    </span>
  );
}

function DayTooltip({ label, action }: { label: string; action?: string }) {
  return (
    <span
      data-ui="status-tooltip"
      className="pointer-events-none absolute bottom-full left-1/2 z-20 mb-2 hidden w-48 -translate-x-1/2 rounded-rail-control border border-rail-border-strong bg-rail-overlay px-3 py-2 text-left text-xs font-normal text-rail-text group-hover/day:block group-focus/day:block"
    >
      <span className="block">{label}</span>
      {action ? <span className="mt-1 block text-rail-subtle">{action}</span> : null}
    </span>
  );
}

function dayAvailability(
  day: { start: Date; end: Date },
  monitoringStartedAt: string | undefined,
  incidents: PublicStatusPageIncidentV1[],
  generatedAt: Date,
): DayAvailability {
  const monitoringStart = monitoringStartedAt
    ? new Date(monitoringStartedAt).getTime()
    : day.start.getTime();
  const measuredStart = Math.max(day.start.getTime(), monitoringStart);
  const measuredEnd = Math.min(day.end.getTime(), generatedAt.getTime());
  if (measuredEnd <= measuredStart) {
    return {
      monitored: false,
      measuredDurationMs: 0,
      degradedRatio: 0,
      downRatio: 0,
      incidents: [],
    };
  }

  const overlapping = incidents.filter((incident) => {
    const start = new Date(incident.startedAt).getTime();
    const end = incident.resolvedAt
      ? new Date(incident.resolvedAt).getTime()
      : generatedAt.getTime();
    return start < measuredEnd && end > measuredStart;
  });
  const measuredDuration = measuredEnd - measuredStart;
  const downMs = overlapDuration(
    overlapping.filter(({ severity }) => severity === 'DOWN'),
    measuredStart,
    measuredEnd,
  );
  const degradedMs = overlapDuration(
    overlapping.filter(({ severity }) => severity === 'DEGRADED'),
    measuredStart,
    measuredEnd,
  );
  return {
    monitored: true,
    measuredDurationMs: measuredDuration,
    downRatio: clampRatio(downMs / measuredDuration),
    degradedRatio: clampRatio(Math.min(degradedMs, measuredDuration - downMs) / measuredDuration),
    incidents: [...overlapping].sort(
      (left, right) => new Date(right.startedAt).getTime() - new Date(left.startedAt).getTime(),
    ),
  };
}

function overlapDuration(
  incidents: PublicStatusPageIncidentV1[],
  rangeStart: number,
  rangeEnd: number,
): number {
  const ranges = incidents
    .map((incident) => ({
      start: Math.max(rangeStart, new Date(incident.startedAt).getTime()),
      end: Math.min(
        rangeEnd,
        incident.resolvedAt ? new Date(incident.resolvedAt).getTime() : rangeEnd,
      ),
    }))
    .filter(({ start, end }) => end > start)
    .sort((left, right) => left.start - right.start);
  let total = 0;
  let cursor = -Infinity;
  for (const range of ranges) {
    total += Math.max(0, range.end - Math.max(range.start, cursor));
    cursor = Math.max(cursor, range.end);
  }
  return total;
}

function measureUptime(
  monitoringStartedAt: string | undefined,
  incidents: PublicStatusPageIncidentV1[],
  rangeStart: number,
  rangeEnd: number,
): UptimeMeasurement {
  const monitoringStart = monitoringStartedAt
    ? new Date(monitoringStartedAt).getTime()
    : rangeStart;
  const measuredStart = Math.max(rangeStart, monitoringStart);
  if (rangeEnd <= measuredStart) {
    return { measuredDurationMs: 0, unavailableDurationMs: 0 };
  }

  return {
    measuredDurationMs: rangeEnd - measuredStart,
    unavailableDurationMs: overlapDuration(
      incidents.filter(({ severity }) => severity === 'DOWN'),
      measuredStart,
      rangeEnd,
    ),
  };
}

function combineUptimeMeasurements(measurements: UptimeMeasurement[]): UptimeMeasurement {
  return measurements.reduce<UptimeMeasurement>(
    (total, measurement) => ({
      measuredDurationMs: total.measuredDurationMs + measurement.measuredDurationMs,
      unavailableDurationMs: total.unavailableDurationMs + measurement.unavailableDurationMs,
    }),
    { measuredDurationMs: 0, unavailableDurationMs: 0 },
  );
}

function formatUptime(measurement: UptimeMeasurement, includeSuffix = false): string {
  if (measurement.measuredDurationMs <= 0) return 'No data';
  const percentage =
    ((measurement.measuredDurationMs - measurement.unavailableDurationMs) /
      measurement.measuredDurationMs) *
    100;
  const value = percentage >= 99.9995 ? '100%' : `${Math.max(0, percentage).toFixed(3)}%`;
  return includeSuffix ? `${value} uptime` : value;
}

function dayLabel(date: Date, availability: DayAvailability): string {
  const label = formatLongDate(date);
  if (!availability.monitored) return `${label}: No monitoring data`;
  const measuredMinutes = Math.max(1, Math.round(availability.measuredDurationMs / 60_000));
  const downMinutes = Math.round(availability.downRatio * measuredMinutes);
  const degradedMinutes = Math.round(availability.degradedRatio * measuredMinutes);
  if (downMinutes > 0) return `${label}: ${formatDuration(downMinutes)} unavailable`;
  if (degradedMinutes > 0) return `${label}: ${formatDuration(degradedMinutes)} degraded`;
  return `${label}: Operational`;
}

function groupComponents(components: PublicStatusPageComponentV1[]) {
  const groups = new Map<string, PublicStatusPageComponentV1[]>();
  for (const component of components) {
    const name = component.groupName ?? 'Services';
    const collection = groups.get(name) ?? [];
    collection.push(component);
    groups.set(name, collection);
  }
  return [...groups].map(([name, groupedComponents]) => ({ name, components: groupedComponents }));
}

function deriveGroupStatus(components: PublicStatusPageComponentV1[]): PublicStatusState {
  if (components.some(({ status }) => status === 'MONITORING_IMPAIRED'))
    return 'MONITORING_IMPAIRED';
  if (components.some(({ status }) => status === 'MAJOR_OUTAGE')) return 'MAJOR_OUTAGE';
  if (components.some(({ status }) => status === 'PARTIAL_OUTAGE')) return 'PARTIAL_OUTAGE';
  return 'OPERATIONAL';
}

function StatusIcon({ status }: { status: PublicStatusState }) {
  const className = `size-4 shrink-0 ${statusIconClass(status)}`;

  if (status === 'OPERATIONAL') {
    return (
      <svg aria-hidden="true" viewBox="0 0 16 16" fill="none" className={className}>
        <circle cx="8" cy="8" r="7" fill="currentColor" />
        <path
          d="m4.75 8.1 2.05 2.05 4.45-4.45"
          stroke="var(--color-rail-canvas)"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    );
  }

  if (status === 'PARTIAL_OUTAGE') {
    return (
      <svg aria-hidden="true" viewBox="0 0 16 16" fill="none" className={className}>
        <path
          d="M7.14 2.5 1.45 12.35A1 1 0 0 0 2.31 13.85h11.38a1 1 0 0 0 .86-1.5L8.86 2.5a1 1 0 0 0-1.72 0Z"
          stroke="currentColor"
          strokeWidth="1.35"
          strokeLinejoin="round"
        />
        <path
          d="M8 5.7v3.5m0 2.05v.05"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
        />
      </svg>
    );
  }

  if (status === 'MAJOR_OUTAGE') {
    return (
      <svg aria-hidden="true" viewBox="0 0 16 16" fill="none" className={className}>
        <circle cx="8" cy="8" r="6.75" stroke="currentColor" strokeWidth="1.5" />
        <path
          d="m5.5 5.5 5 5m0-5-5 5"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
        />
      </svg>
    );
  }

  return (
    <svg aria-hidden="true" viewBox="0 0 16 16" fill="none" className={className}>
      <circle cx="8" cy="8" r="6.75" stroke="currentColor" strokeWidth="1.5" />
      <path
        d="M8 4.6v4.2m0 2.5v.05"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

function ChevronIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      className="size-3.5 text-rail-muted transition-transform duration-150 group-open/status:rotate-180 motion-reduce:transition-none"
      aria-hidden="true"
    >
      <path d="m4 6 4 4 4-4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function statusIconClass(state: PublicStatusState): string {
  if (state === 'OPERATIONAL') return 'text-rail-success';
  if (state === 'PARTIAL_OUTAGE') return 'text-rail-warning';
  if (state === 'MAJOR_OUTAGE') return 'text-rail-danger';
  return 'text-rail-impaired';
}

function incidentVisualHeight(ratio: number): string {
  // A square-root scale preserves relative duration while keeping brief incidents discoverable.
  return `${Math.max(12.5, Math.sqrt(clampRatio(ratio)) * 100)}%`;
}

function stateLabel(state: PublicStatusState): string {
  if (state === 'OPERATIONAL') return 'Operational';
  if (state === 'PARTIAL_OUTAGE') return 'Degraded';
  if (state === 'MAJOR_OUTAGE') return 'Major outage';
  return 'Status unavailable';
}

function clampRatio(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function formatDuration(minutes: number): string {
  if (minutes < 60) return `${Math.max(1, minutes)} min`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return remainder === 0 ? `${hours} hr` : `${hours} hr ${remainder} min`;
}

function startOfUtcDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function formatDate(date: Date): string {
  return new Intl.DateTimeFormat('en-GB', {
    day: '2-digit',
    month: 'short',
    timeZone: 'UTC',
  }).format(date);
}

function formatLongDate(date: Date): string {
  return new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(date);
}
