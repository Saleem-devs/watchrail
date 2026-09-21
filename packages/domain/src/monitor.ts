export const HTTP_METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'] as const;
export const MONITOR_LIFECYCLE_STATES = ['ENABLED', 'PAUSED', 'ARCHIVED'] as const;
export const MONITOR_LOCATIONS = ['local'] as const;

export type HttpMethod = (typeof HTTP_METHODS)[number];
export type MonitorLifecycleState = (typeof MONITOR_LIFECYCLE_STATES)[number];

export const MONITOR_DEFAULTS = {
  method: 'GET',
  lifecycleState: 'ENABLED',
  timeoutMs: 10_000,
  locations: [...MONITOR_LOCATIONS],
} as const satisfies {
  method: HttpMethod;
  lifecycleState: MonitorLifecycleState;
  timeoutMs: number;
  locations: readonly string[];
};

export interface CreateMonitorCommand {
  name: unknown;
  url: unknown;
}

export interface NewMonitor {
  name: string;
  url: string;
  method: HttpMethod;
  lifecycleState: MonitorLifecycleState;
  timeoutMs: number;
  locations: string[];
}

export interface MonitorFieldErrors {
  name?: string[];
  url?: string[];
}

export class MonitorInputError extends Error {
  readonly fields: MonitorFieldErrors;

  constructor(fields: MonitorFieldErrors) {
    super('Monitor input is invalid.');
    this.name = 'MonitorInputError';
    this.fields = fields;
  }
}

export function createMonitor(command: CreateMonitorCommand): NewMonitor {
  const fields: MonitorFieldErrors = {};
  const name = normalizeName(command.name, fields);
  const url = normalizeUrl(command.url, fields);

  if (Object.keys(fields).length > 0) throw new MonitorInputError(fields);

  return {
    name,
    url,
    method: MONITOR_DEFAULTS.method,
    lifecycleState: MONITOR_DEFAULTS.lifecycleState,
    timeoutMs: MONITOR_DEFAULTS.timeoutMs,
    locations: [...MONITOR_DEFAULTS.locations],
  };
}

function normalizeName(value: unknown, fields: MonitorFieldErrors): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    fields.name = ['Enter a monitor name.'];
    return '';
  }

  const name = value.trim();
  if (name.length > 120) fields.name = ['Use 120 characters or fewer.'];
  return name;
}

function normalizeUrl(value: unknown, fields: MonitorFieldErrors): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    fields.url = ['Enter an HTTP or HTTPS URL.'];
    return '';
  }

  if (value.length > 2_048) {
    fields.url = ['Use 2,048 characters or fewer.'];
    return '';
  }

  try {
    const url = new URL(value.trim());
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      fields.url = ['Use an HTTP or HTTPS URL.'];
      return '';
    }
    if (!url.hostname) {
      fields.url = ['Enter a URL with a hostname.'];
      return '';
    }
    if (url.username || url.password) {
      fields.url = ['Credentials are not allowed in the URL.'];
      return '';
    }
    return url.toString();
  } catch {
    fields.url = ['Enter a valid absolute URL.'];
    return '';
  }
}
