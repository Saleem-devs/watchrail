export const TCP_CHECK_TIMEOUT_LIMITS = {
  minimumMs: 1_000,
  maximumMs: 30_000,
} as const;

export const TCP_MONITOR_DEFAULTS = {
  timeoutMs: 10_000,
} as const;

export interface TcpMonitorSettings {
  host: string;
  port: number;
  timeoutMs: number;
}

export interface TcpMonitorFieldErrors {
  host?: string[];
  port?: string[];
  timeoutMs?: string[];
  tcpSettings?: string[];
}

export class TcpMonitorInputError extends Error {
  readonly fields: TcpMonitorFieldErrors;

  constructor(fields: TcpMonitorFieldErrors) {
    super('TCP monitor input is invalid.');
    this.name = 'TcpMonitorInputError';
    this.fields = fields;
  }
}

export function parseTcpMonitorSettings(value: unknown): TcpMonitorSettings {
  if (!hasExactKeys(value, ['host', 'port', 'timeoutMs'])) {
    throw new TcpMonitorInputError({
      tcpSettings: ['Provide exactly host, port, and timeoutMs.'],
    });
  }

  const fields: TcpMonitorFieldErrors = {};
  const host = normalizeTcpHost(value.host, fields);
  const port = normalizeTcpPort(value.port, fields);
  const timeoutMs = normalizeTcpTimeout(value.timeoutMs, fields);

  if (Object.keys(fields).length > 0) throw new TcpMonitorInputError(fields);
  return { host, port, timeoutMs };
}

function normalizeTcpHost(value: unknown, fields: TcpMonitorFieldErrors): string {
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

function normalizeTcpPort(value: unknown, fields: TcpMonitorFieldErrors): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 65_535) {
    fields.port = ['Use a whole-number port from 1 to 65535.'];
    return 443;
  }
  return value;
}

function normalizeTcpTimeout(value: unknown, fields: TcpMonitorFieldErrors): number {
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < TCP_CHECK_TIMEOUT_LIMITS.minimumMs ||
    value > TCP_CHECK_TIMEOUT_LIMITS.maximumMs
  ) {
    fields.timeoutMs = [
      `Use a whole-number timeout from ${TCP_CHECK_TIMEOUT_LIMITS.minimumMs} to ${TCP_CHECK_TIMEOUT_LIMITS.maximumMs} milliseconds.`,
    ];
    return TCP_MONITOR_DEFAULTS.timeoutMs;
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
