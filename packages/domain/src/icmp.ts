export const ICMP_CHECK_TIMEOUT_LIMITS = {
  minimumMs: 1_000,
  maximumMs: 30_000,
} as const;

export const ICMP_MONITOR_DEFAULTS = {
  timeoutMs: 5_000,
} as const;

export interface IcmpMonitorSettings {
  host: string;
  timeoutMs: number;
}

export interface IcmpMonitorFieldErrors {
  host?: string[];
  timeoutMs?: string[];
  icmpSettings?: string[];
}

export class IcmpMonitorInputError extends Error {
  readonly fields: IcmpMonitorFieldErrors;

  constructor(fields: IcmpMonitorFieldErrors) {
    super('ICMP monitor input is invalid.');
    this.name = 'IcmpMonitorInputError';
    this.fields = fields;
  }
}

export function parseIcmpMonitorSettings(value: unknown): IcmpMonitorSettings {
  if (!hasExactKeys(value, ['host', 'timeoutMs'])) {
    throw new IcmpMonitorInputError({
      icmpSettings: ['Provide exactly host and timeoutMs.'],
    });
  }

  const fields: IcmpMonitorFieldErrors = {};
  const host = normalizeIcmpHost(value.host, fields);
  const timeoutMs = normalizeIcmpTimeout(value.timeoutMs, fields);

  if (Object.keys(fields).length > 0) throw new IcmpMonitorInputError(fields);
  return { host, timeoutMs };
}

function normalizeIcmpHost(value: unknown, fields: IcmpMonitorFieldErrors): string {
  if (typeof value !== 'string') {
    fields.host = ['Enter a hostname or IP address.'];
    return '';
  }

  const host = value.trim().toLowerCase();
  if (
    host === '' ||
    host.length > 253 ||
    host.includes('://') ||
    host.includes('/') ||
    host.includes('@')
  ) {
    fields.host = ['Enter a hostname or IP address without a protocol, path, or credentials.'];
    return '';
  }

  const unwrapped = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
  if (unwrapped === '' || /\s/u.test(unwrapped)) {
    fields.host = ['Enter a valid hostname or IP address.'];
    return '';
  }

  return unwrapped;
}

function normalizeIcmpTimeout(value: unknown, fields: IcmpMonitorFieldErrors): number {
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < ICMP_CHECK_TIMEOUT_LIMITS.minimumMs ||
    value > ICMP_CHECK_TIMEOUT_LIMITS.maximumMs
  ) {
    fields.timeoutMs = [
      `Use a whole-number timeout from ${ICMP_CHECK_TIMEOUT_LIMITS.minimumMs} to ${ICMP_CHECK_TIMEOUT_LIMITS.maximumMs} milliseconds.`,
    ];
    return ICMP_MONITOR_DEFAULTS.timeoutMs;
  }
  return value;
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
