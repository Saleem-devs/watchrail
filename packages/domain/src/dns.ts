export const DNS_RECORD_TYPES = ['A', 'AAAA', 'CNAME', 'MX', 'TXT', 'NS'] as const;

export const DNS_CHECK_TIMEOUT_LIMITS = {
  minimumMs: 1_000,
  maximumMs: 30_000,
} as const;

export const DNS_EXPECTED_VALUE_LIMITS = {
  maximumCount: 32,
  maximumLength: 512,
} as const;

export const DNS_MONITOR_DEFAULTS = {
  recordType: 'A',
  timeoutMs: 10_000,
  expectedValues: [] as string[],
} as const;

export type DnsRecordType = (typeof DNS_RECORD_TYPES)[number];

export interface DnsMonitorSettings {
  name: string;
  recordType: DnsRecordType;
  expectedValues: string[];
  timeoutMs: number;
}

export interface DnsMonitorFieldErrors {
  dnsName?: string[];
  dnsRecordType?: string[];
  dnsExpectedValues?: string[];
  timeoutMs?: string[];
  dnsSettings?: string[];
}

export class DnsMonitorInputError extends Error {
  readonly fields: DnsMonitorFieldErrors;

  constructor(fields: DnsMonitorFieldErrors) {
    super('DNS monitor input is invalid.');
    this.name = 'DnsMonitorInputError';
    this.fields = fields;
  }
}

export function parseDnsMonitorSettings(value: unknown): DnsMonitorSettings {
  if (!hasExactKeys(value, ['expectedValues', 'name', 'recordType', 'timeoutMs'])) {
    throw new DnsMonitorInputError({
      dnsSettings: ['Provide exactly name, recordType, expectedValues, and timeoutMs.'],
    });
  }

  const fields: DnsMonitorFieldErrors = {};
  const name = normalizeDnsName(value.name, fields);
  const recordType = normalizeDnsRecordType(value.recordType, fields);
  const expectedValues = normalizeDnsExpectedValues(value.expectedValues, recordType, fields);
  const timeoutMs = normalizeDnsTimeout(value.timeoutMs, fields);

  if (Object.keys(fields).length > 0) throw new DnsMonitorInputError(fields);
  return { name, recordType, expectedValues, timeoutMs };
}

export function normalizeDnsAnswer(recordType: DnsRecordType, value: string): string {
  const trimmed = value.trim();
  if (recordType === 'AAAA') {
    return normalizeIpv6Address(trimmed);
  }
  if (recordType === 'CNAME' || recordType === 'NS') {
    return trimmed.toLowerCase().replace(/\.$/u, '');
  }
  if (recordType === 'MX') {
    const match = /^(\d+)\s+(.+)$/u.exec(trimmed);
    if (!match) return trimmed.toLowerCase();
    return `${Number(match[1])} ${String(match[2]).toLowerCase().replace(/\.$/u, '')}`;
  }
  return trimmed;
}

function normalizeIpv6Address(value: string): string {
  try {
    const hostname = new URL(`http://[${value}]/`).hostname;
    return hostname.slice(1, -1);
  } catch {
    return value.toLowerCase();
  }
}

function normalizeDnsName(value: unknown, fields: DnsMonitorFieldErrors): string {
  if (typeof value !== 'string') {
    fields.dnsName = ['Enter a DNS name.'];
    return '';
  }
  const name = value.trim().toLowerCase().replace(/\.$/u, '');
  if (
    name === '' ||
    name.length > 253 ||
    name.includes('://') ||
    name.includes('/') ||
    name.includes('@') ||
    /\s/u.test(name)
  ) {
    fields.dnsName = ['Enter a DNS name without a protocol, path, credentials, or spaces.'];
    return '';
  }
  const labels = name.split('.');
  if (
    labels.some(
      (label) =>
        label.length === 0 ||
        label.length > 63 ||
        !/^[a-z0-9_](?:[a-z0-9_-]*[a-z0-9_])?$/u.test(label),
    )
  ) {
    fields.dnsName = ['Enter a valid DNS name.'];
    return '';
  }
  return name;
}

function normalizeDnsRecordType(value: unknown, fields: DnsMonitorFieldErrors): DnsRecordType {
  if (typeof value !== 'string' || !DNS_RECORD_TYPES.includes(value as DnsRecordType)) {
    fields.dnsRecordType = ['Choose A, AAAA, CNAME, MX, TXT, or NS.'];
    return DNS_MONITOR_DEFAULTS.recordType;
  }
  return value as DnsRecordType;
}

function normalizeDnsExpectedValues(
  value: unknown,
  recordType: DnsRecordType,
  fields: DnsMonitorFieldErrors,
): string[] {
  if (!Array.isArray(value) || value.length > DNS_EXPECTED_VALUE_LIMITS.maximumCount) {
    fields.dnsExpectedValues = [
      `Provide up to ${DNS_EXPECTED_VALUE_LIMITS.maximumCount} expected values.`,
    ];
    return [];
  }
  const normalized: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') {
      fields.dnsExpectedValues = ['Every expected DNS value must be text.'];
      return [];
    }
    const answer = normalizeDnsAnswer(recordType, item);
    if (answer === '' || answer.length > DNS_EXPECTED_VALUE_LIMITS.maximumLength) {
      fields.dnsExpectedValues = [
        `Expected DNS values must contain 1 to ${DNS_EXPECTED_VALUE_LIMITS.maximumLength} characters.`,
      ];
      return [];
    }
    normalized.push(answer);
  }
  return [...new Set(normalized)];
}

function normalizeDnsTimeout(value: unknown, fields: DnsMonitorFieldErrors): number {
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < DNS_CHECK_TIMEOUT_LIMITS.minimumMs ||
    value > DNS_CHECK_TIMEOUT_LIMITS.maximumMs
  ) {
    fields.timeoutMs = [
      `Use a whole-number timeout from ${DNS_CHECK_TIMEOUT_LIMITS.minimumMs} to ${DNS_CHECK_TIMEOUT_LIMITS.maximumMs} milliseconds.`,
    ];
    return DNS_MONITOR_DEFAULTS.timeoutMs;
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
