export const HTTP_METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'] as const;
export const HTTP_MONITOR_METHODS = ['GET', 'HEAD'] as const;
export const MONITOR_LIFECYCLE_STATES = ['ENABLED', 'PAUSED', 'ARCHIVED'] as const;
export const MONITOR_LOCATIONS = ['local'] as const;

export type HttpMethod = (typeof HTTP_METHODS)[number];
export type HttpMonitorMethod = (typeof HTTP_MONITOR_METHODS)[number];
export type MonitorLifecycleState = (typeof MONITOR_LIFECYCLE_STATES)[number];
export type HttpStatusPolicy = { type: 'ANY_2XX' } | { type: 'EXACT'; statusCodes: number[] };

export const MONITOR_DEFAULTS = {
  method: 'GET',
  lifecycleState: 'ENABLED',
  timeoutMs: 10_000,
  followRedirects: true,
  statusPolicy: { type: 'ANY_2XX' } as const,
  locations: [...MONITOR_LOCATIONS],
} as const satisfies {
  method: HttpMethod;
  lifecycleState: MonitorLifecycleState;
  timeoutMs: number;
  followRedirects: boolean;
  statusPolicy: HttpStatusPolicy;
  locations: readonly string[];
};

export interface CreateMonitorCommand {
  name: unknown;
  url: unknown;
  statusPolicy?: unknown;
  requestHeaders?: unknown;
}

export interface NewMonitor {
  name: string;
  url: string;
  method: HttpMonitorMethod;
  lifecycleState: MonitorLifecycleState;
  timeoutMs: number;
  followRedirects: boolean;
  statusPolicy: HttpStatusPolicy;
  requestHeaders: RequestHeaderUpdate[];
  locations: string[];
}

export interface MonitorFieldErrors {
  name?: string[];
  url?: string[];
  statusPolicy?: string[];
  requestHeaders?: string[];
  method?: string[];
  timeoutMs?: string[];
  followRedirects?: string[];
  httpSettings?: string[];
}

export interface HttpMonitorSettings {
  url: string;
  method: HttpMonitorMethod;
  timeoutMs: number;
  followRedirects: boolean;
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
  const statusPolicy = normalizeStatusPolicy(command.statusPolicy, fields);
  const requestHeaders = normalizeHeaders(command.requestHeaders, fields);

  if (Object.keys(fields).length > 0) throw new MonitorInputError(fields);

  return {
    name,
    url,
    method: MONITOR_DEFAULTS.method,
    lifecycleState: MONITOR_DEFAULTS.lifecycleState,
    timeoutMs: MONITOR_DEFAULTS.timeoutMs,
    followRedirects: MONITOR_DEFAULTS.followRedirects,
    statusPolicy,
    requestHeaders,
    locations: [...MONITOR_DEFAULTS.locations],
  };
}

function normalizeHeaders(value: unknown, fields: MonitorFieldErrors): RequestHeaderUpdate[] {
  if (value === undefined) return [];

  try {
    const headers = normalizeRequestHeaderUpdates(value);
    assertNoRetainedHeaders(headers);
    return headers;
  } catch (error) {
    if (error instanceof RequestHeaderInputError) {
      fields.requestHeaders = error.issues;
      return [];
    }
    throw error;
  }
}

export function parseHttpStatusPolicy(value: unknown): HttpStatusPolicy {
  const fields: MonitorFieldErrors = {};
  const policy = normalizeStatusPolicy(value, fields);
  if (fields.statusPolicy) throw new MonitorInputError(fields);
  return policy;
}

export function parseHttpMonitorSettings(value: unknown): HttpMonitorSettings {
  const fields: MonitorFieldErrors = {};
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new MonitorInputError({
      httpSettings: ['Provide the complete HTTP monitor settings object.'],
    });
  }

  const settings = value as Record<string, unknown>;
  const expectedKeys = ['followRedirects', 'method', 'timeoutMs', 'url'];
  const keys = Object.keys(settings).sort();
  if (
    keys.length !== expectedKeys.length ||
    keys.some((key, index) => key !== expectedKeys[index])
  ) {
    fields.httpSettings = ['Provide exactly url, method, timeoutMs, and followRedirects.'];
  }

  const url = normalizeUrl(settings.url, fields);
  const method = normalizeHttpMonitorMethod(settings.method, fields);
  const timeoutMs = normalizeTimeout(settings.timeoutMs, fields);
  const followRedirects = normalizeFollowRedirects(settings.followRedirects, fields);

  if (Object.keys(fields).length > 0) throw new MonitorInputError(fields);
  return { url, method, timeoutMs, followRedirects };
}

function normalizeStatusPolicy(value: unknown, fields: MonitorFieldErrors): HttpStatusPolicy {
  if (value === undefined) return { type: 'ANY_2XX' };

  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fields.statusPolicy = ['Choose a valid expected-status policy.'];
    return { type: 'ANY_2XX' };
  }

  const policy = value as Record<string, unknown>;
  if (policy.type === 'ANY_2XX') return { type: 'ANY_2XX' };

  if (policy.type !== 'EXACT' || !Array.isArray(policy.statusCodes)) {
    fields.statusPolicy = ['Choose any 2xx response or provide specific status codes.'];
    return { type: 'ANY_2XX' };
  }

  if (
    policy.statusCodes.length === 0 ||
    policy.statusCodes.some(
      (code) => !Number.isInteger(code) || (code as number) < 100 || (code as number) > 599,
    )
  ) {
    fields.statusPolicy = ['Enter one or more integer status codes from 100 to 599.'];
    return { type: 'ANY_2XX' };
  }

  return {
    type: 'EXACT',
    statusCodes: [...new Set(policy.statusCodes as number[])].sort((left, right) => left - right),
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

function normalizeHttpMonitorMethod(value: unknown, fields: MonitorFieldErrors): HttpMonitorMethod {
  if (value !== 'GET' && value !== 'HEAD') {
    fields.method = ['Choose GET or HEAD.'];
    return 'GET';
  }
  return value;
}

function normalizeTimeout(value: unknown, fields: MonitorFieldErrors): number {
  if (!Number.isInteger(value) || (value as number) < 1_000 || (value as number) > 30_000) {
    fields.timeoutMs = ['Enter an integer timeout from 1,000 to 30,000 milliseconds.'];
    return MONITOR_DEFAULTS.timeoutMs;
  }
  return value as number;
}

function normalizeFollowRedirects(value: unknown, fields: MonitorFieldErrors): boolean {
  if (typeof value !== 'boolean') {
    fields.followRedirects = ['Choose whether Watchrail should follow redirects.'];
    return MONITOR_DEFAULTS.followRedirects;
  }
  return value;
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
import {
  assertNoRetainedHeaders,
  normalizeRequestHeaderUpdates,
  RequestHeaderInputError,
  type RequestHeaderUpdate,
} from './request-header.js';
