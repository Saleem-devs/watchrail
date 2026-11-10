export const STATUS_PAGE_INCIDENT_STATES = [
  'INVESTIGATING',
  'IDENTIFIED',
  'MONITORING',
  'RESOLVED',
] as const;
export type StatusPageIncidentState = (typeof STATUS_PAGE_INCIDENT_STATES)[number];

export const STATUS_PAGE_INCIDENT_IMPACTS = ['DEGRADED', 'DOWN'] as const;
export type StatusPageIncidentImpact = (typeof STATUS_PAGE_INCIDENT_IMPACTS)[number];

export const STATUS_PAGE_INCIDENT_LIMITS = {
  maximumTitleLength: 160,
  maximumMessageLength: 2_000,
  maximumAffectedComponents: 100,
} as const;

export class StatusPageIncidentInputError extends Error {
  constructor(readonly issues: string[]) {
    super('Status page incident input is invalid.');
    this.name = 'StatusPageIncidentInputError';
  }
}

export function parseStatusPageIncidentCreate(value: unknown): {
  title: string;
  impact: StatusPageIncidentImpact;
  message: string;
  componentIds: string[];
} {
  if (!isRecord(value)) throw new StatusPageIncidentInputError(['Provide an incident object.']);
  const allowed = new Set(['componentIds', 'impact', 'message', 'title']);
  const issues = Object.keys(value).some((key) => !allowed.has(key))
    ? ['The incident contains an unsupported field.']
    : [];
  const title = requiredText(
    value.title,
    'title',
    STATUS_PAGE_INCIDENT_LIMITS.maximumTitleLength,
    issues,
  );
  const message = requiredText(
    value.message,
    'message',
    STATUS_PAGE_INCIDENT_LIMITS.maximumMessageLength,
    issues,
  );
  const impact = STATUS_PAGE_INCIDENT_IMPACTS.includes(value.impact as StatusPageIncidentImpact)
    ? (value.impact as StatusPageIncidentImpact)
    : (issues.push('impact must be DEGRADED or DOWN.'), 'DEGRADED');
  const componentIds = parseComponentIds(value.componentIds, issues);
  if (issues.length > 0) throw new StatusPageIncidentInputError(issues);
  return { title, impact, message, componentIds };
}

export function parseStatusPageIncidentUpdate(value: unknown): {
  state: StatusPageIncidentState;
  message: string;
} {
  if (!isRecord(value)) throw new StatusPageIncidentInputError(['Provide an update object.']);
  const issues = Object.keys(value).some((key) => !['message', 'state'].includes(key))
    ? ['The update contains an unsupported field.']
    : [];
  const message = requiredText(
    value.message,
    'message',
    STATUS_PAGE_INCIDENT_LIMITS.maximumMessageLength,
    issues,
  );
  const state = STATUS_PAGE_INCIDENT_STATES.includes(value.state as StatusPageIncidentState)
    ? (value.state as StatusPageIncidentState)
    : (issues.push('state is not supported.'), 'INVESTIGATING');
  if (issues.length > 0) throw new StatusPageIncidentInputError(issues);
  return { state, message };
}

export function canTransitionStatusPageIncident(
  current: StatusPageIncidentState,
  next: StatusPageIncidentState,
): boolean {
  if (current === 'RESOLVED') return false;
  const order: Record<StatusPageIncidentState, number> = {
    INVESTIGATING: 0,
    IDENTIFIED: 1,
    MONITORING: 2,
    RESOLVED: 3,
  };
  return order[next] >= order[current];
}

function parseComponentIds(value: unknown, issues: string[]): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    issues.push('componentIds must contain at least one component.');
    return [];
  }
  if (value.length > STATUS_PAGE_INCIDENT_LIMITS.maximumAffectedComponents) {
    issues.push(
      `componentIds must contain at most ${STATUS_PAGE_INCIDENT_LIMITS.maximumAffectedComponents} items.`,
    );
  }
  const result: string[] = [];
  for (const componentId of value) {
    if (typeof componentId !== 'string' || componentId.trim().length === 0) {
      issues.push('componentIds must contain non-empty strings.');
      continue;
    }
    result.push(componentId);
  }
  if (new Set(result).size !== result.length)
    issues.push('componentIds must not contain duplicates.');
  return result;
}

function requiredText(value: unknown, field: string, maximum: number, issues: string[]): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > maximum) {
    issues.push(`${field} must be a non-empty string no longer than ${maximum} characters.`);
    return '';
  }
  return value.trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
