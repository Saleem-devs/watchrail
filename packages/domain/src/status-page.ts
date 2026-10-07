import type { AvailabilityWindowState } from './availability.js';
import type { MonitorLifecycleState } from './monitor.js';

export const PUBLIC_STATUS_STATES = [
  'OPERATIONAL',
  'PARTIAL_OUTAGE',
  'MAJOR_OUTAGE',
  'MONITORING_IMPAIRED',
] as const;
export type PublicStatusState = (typeof PUBLIC_STATUS_STATES)[number];

export const STATUS_PAGE_LIMITS = {
  minimumSlugLength: 3,
  maximumSlugLength: 63,
  maximumNameLength: 100,
  maximumComponentNameLength: 100,
  maximumComponents: 100,
} as const;

/**
 * Public responses may be cached for 30 seconds and served stale while one
 * refresh is attempted for a further 30 seconds. A healthy public read path
 * therefore reflects committed state within 60 seconds.
 */
export const STATUS_PAGE_CACHE_POLICY = {
  maxAgeSeconds: 30,
  staleWhileRevalidateSeconds: 30,
  freshnessTargetSeconds: 60,
} as const;

/** Resolved incidents remain public for 90 complete days after resolution. */
export const STATUS_PAGE_RESOLVED_INCIDENT_RETENTION_DAYS = 90;

export interface StatusPageComponent {
  id: string;
  displayName: string;
  monitorId: string;
  position: number;
}

export interface StatusPage {
  organizationId: string;
  name: string;
  slug: string;
  published: boolean;
  components: StatusPageComponent[];
}

export interface StatusPageComponentHealth {
  lifecycleState: MonitorLifecycleState;
  availabilityState: AvailabilityWindowState;
  hasActiveIncident: boolean;
}

export interface PublicStatusPageComponentV1 {
  id: string;
  displayName: string;
  position: number;
  status: PublicStatusState;
}

export interface PublicStatusPageIncidentV1 {
  id: string;
  componentId: string;
  status: 'OPEN' | 'RESOLVED';
  startedAt: string;
  openedAt: string;
  resolvedAt: string | null;
}

/**
 * The complete public allow-list. In particular it deliberately has no
 * organization ID, monitor ID/URL, probe data, assertions, headers, response
 * values, or notification configuration/delivery fields.
 */
export interface PublicStatusPageProjectionV1 {
  contractVersion: 1;
  name: string;
  slug: string;
  status: PublicStatusState;
  components: PublicStatusPageComponentV1[];
  activeIncidents: PublicStatusPageIncidentV1[];
  resolvedIncidents: PublicStatusPageIncidentV1[];
  generatedAt: string;
}

export type PublicStatusPageLookup =
  { visibility: 'PUBLIC'; page: PublicStatusPageProjectionV1 } | { visibility: 'NOT_FOUND' };

export class StatusPageInputError extends Error {
  readonly issues: string[];

  constructor(issues: string[]) {
    super('Status page input is invalid.');
    this.name = 'StatusPageInputError';
    this.issues = issues;
  }
}

export function parseStatusPage(value: unknown): StatusPage {
  if (!hasExactKeys(value, ['components', 'name', 'organizationId', 'published', 'slug'])) {
    throw new StatusPageInputError([
      'Provide exactly organizationId, name, slug, published, and components.',
    ]);
  }

  const issues: string[] = [];
  const organizationId = parseNonEmptyString(value.organizationId, 'organizationId', 120, issues);
  const name = parseNonEmptyString(
    value.name,
    'name',
    STATUS_PAGE_LIMITS.maximumNameLength,
    issues,
  );
  const slug = parseSlug(value.slug, issues);
  if (typeof value.published !== 'boolean') issues.push('published must be a boolean.');

  const components: StatusPageComponent[] = [];
  if (!Array.isArray(value.components)) {
    issues.push('components must be an array.');
  } else if (value.components.length > STATUS_PAGE_LIMITS.maximumComponents) {
    issues.push(`components must contain at most ${STATUS_PAGE_LIMITS.maximumComponents} items.`);
  } else {
    for (const [index, component] of value.components.entries()) {
      const parsed = parseComponent(component, index, issues);
      if (parsed) components.push(parsed);
    }
  }

  const ids = new Set<string>();
  const monitorIds = new Set<string>();
  const positions = new Set<number>();
  for (const component of components) {
    if (ids.has(component.id)) issues.push(`components contains duplicate id ${component.id}.`);
    if (monitorIds.has(component.monitorId))
      issues.push(`components contains duplicate monitorId ${component.monitorId}.`);
    if (positions.has(component.position))
      issues.push(`components contains duplicate position ${component.position}.`);
    ids.add(component.id);
    monitorIds.add(component.monitorId);
    positions.add(component.position);
  }

  if (issues.length > 0) throw new StatusPageInputError(issues);
  return {
    organizationId,
    name,
    slug,
    published: value.published as boolean,
    components: components.sort((left, right) => left.position - right.position),
  };
}

export function derivePublicComponentStatus(health: StatusPageComponentHealth): PublicStatusState {
  if (health.lifecycleState !== 'ENABLED') return 'MONITORING_IMPAIRED';
  if (health.hasActiveIncident || health.availabilityState === 'UNAVAILABLE') {
    return 'MAJOR_OUTAGE';
  }
  if (health.availabilityState === 'UNKNOWN' || health.availabilityState === 'EXCLUDED') {
    return 'MONITORING_IMPAIRED';
  }
  return 'OPERATIONAL';
}

export function derivePublicPageStatus(
  componentStatuses: readonly PublicStatusState[],
): PublicStatusState {
  if (componentStatuses.length === 0) return 'MONITORING_IMPAIRED';
  const outages = componentStatuses.filter((status) => status === 'MAJOR_OUTAGE').length;
  if (outages === componentStatuses.length) return 'MAJOR_OUTAGE';
  if (outages > 0) return 'PARTIAL_OUTAGE';
  if (componentStatuses.some((status) => status === 'MONITORING_IMPAIRED')) {
    return 'MONITORING_IMPAIRED';
  }
  return 'OPERATIONAL';
}

/** Unpublished and unknown slugs deliberately have indistinguishable public behavior. */
export function publicStatusPageVisibility(published: boolean): 'PUBLIC' | 'NOT_FOUND' {
  return published ? 'PUBLIC' : 'NOT_FOUND';
}

export function resolvedIncidentIsPublic(resolvedAt: Date, cutoff: Date): boolean {
  assertValidDate(resolvedAt, 'resolvedAt');
  assertValidDate(cutoff, 'cutoff');
  const retentionMs = STATUS_PAGE_RESOLVED_INCIDENT_RETENTION_DAYS * 24 * 60 * 60 * 1_000;
  return resolvedAt.getTime() >= cutoff.getTime() - retentionMs && resolvedAt <= cutoff;
}

function parseComponent(
  value: unknown,
  index: number,
  issues: string[],
): StatusPageComponent | null {
  const prefix = `components[${index}]`;
  if (!hasExactKeys(value, ['displayName', 'id', 'monitorId', 'position'])) {
    issues.push(`${prefix} must contain exactly id, displayName, monitorId, and position.`);
    return null;
  }
  const id = parseNonEmptyString(value.id, `${prefix}.id`, 120, issues);
  const displayName = parseNonEmptyString(
    value.displayName,
    `${prefix}.displayName`,
    STATUS_PAGE_LIMITS.maximumComponentNameLength,
    issues,
  );
  const monitorId = parseNonEmptyString(value.monitorId, `${prefix}.monitorId`, 120, issues);
  if (!Number.isSafeInteger(value.position) || (value.position as number) < 0) {
    issues.push(`${prefix}.position must be a non-negative safe integer.`);
  }
  return {
    id,
    displayName,
    monitorId,
    position: Number.isSafeInteger(value.position) ? (value.position as number) : 0,
  };
}

function parseSlug(value: unknown, issues: string[]): string {
  if (
    typeof value !== 'string' ||
    value.length < STATUS_PAGE_LIMITS.minimumSlugLength ||
    value.length > STATUS_PAGE_LIMITS.maximumSlugLength ||
    !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(value)
  ) {
    issues.push(
      `slug must be ${STATUS_PAGE_LIMITS.minimumSlugLength}-${STATUS_PAGE_LIMITS.maximumSlugLength} lowercase letters, numbers, or single hyphens.`,
    );
    return '';
  }
  return value;
}

function parseNonEmptyString(
  value: unknown,
  field: string,
  maximumLength: number,
  issues: string[],
): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > maximumLength) {
    issues.push(`${field} must be a non-empty string no longer than ${maximumLength} characters.`);
    return '';
  }
  return value.trim();
}

function hasExactKeys(
  value: unknown,
  expected: readonly string[],
): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const keys = Object.keys(value).sort();
  const required = [...expected].sort();
  return keys.length === required.length && keys.every((key, index) => key === required[index]);
}

function assertValidDate(value: Date, name: string): void {
  if (Number.isNaN(value.getTime())) throw new RangeError(`${name} must be a valid date.`);
}
