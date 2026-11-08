export const DOMAIN_EXPIRY_WARNING_LIMITS = {
  minimumDays: 1,
  maximumDays: 365,
  defaultDays: 30,
} as const;

export const DOMAIN_EXPIRY_TIMEOUT_LIMITS = {
  minimumMs: 1_000,
  maximumMs: 30_000,
  defaultMs: 10_000,
} as const;

export interface DomainExpiryMonitorSettings {
  domainName: string;
  warningDays: number;
  timeoutMs: number;
}

export interface DomainExpiryFieldErrors {
  domainName?: string[];
  domainWarningDays?: string[];
  timeoutMs?: string[];
}

export class DomainExpiryInputError extends Error {
  constructor(readonly fields: DomainExpiryFieldErrors) {
    super('Domain expiry monitor input is invalid.');
    this.name = 'DomainExpiryInputError';
  }
}

export function parseDomainExpiryMonitorSettings(value: {
  domainName: unknown;
  warningDays: unknown;
  timeoutMs: unknown;
}): DomainExpiryMonitorSettings {
  const fields: DomainExpiryFieldErrors = {};
  const domainName = normalizeDomainName(value.domainName, fields);
  const warningDays = normalizeWarningDays(value.warningDays, fields);
  const timeoutMs = normalizeTimeout(value.timeoutMs, fields);
  if (Object.keys(fields).length > 0) throw new DomainExpiryInputError(fields);
  return { domainName, warningDays, timeoutMs };
}

function normalizeDomainName(value: unknown, fields: DomainExpiryFieldErrors): string {
  if (typeof value !== 'string') {
    fields.domainName = ['Enter a registered domain name.'];
    return '';
  }
  const candidate = value.trim().replace(/\.$/u, '').toLowerCase();
  const ascii = [...candidate].every((character) => character.charCodeAt(0) <= 0x7f)
    ? candidate
    : '';
  if (
    ascii === '' ||
    ascii.length > 253 ||
    !ascii.includes('.') ||
    ascii
      .split('.')
      .some(
        (label) =>
          label.length === 0 ||
          label.length > 63 ||
          !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(label),
      )
  ) {
    fields.domainName = ['Enter a valid registered domain, such as example.com.'];
    return '';
  }
  return ascii;
}

function normalizeWarningDays(value: unknown, fields: DomainExpiryFieldErrors): number {
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < DOMAIN_EXPIRY_WARNING_LIMITS.minimumDays ||
    value > DOMAIN_EXPIRY_WARNING_LIMITS.maximumDays
  ) {
    fields.domainWarningDays = [
      `Choose a warning threshold from ${DOMAIN_EXPIRY_WARNING_LIMITS.minimumDays} to ${DOMAIN_EXPIRY_WARNING_LIMITS.maximumDays} days.`,
    ];
    return DOMAIN_EXPIRY_WARNING_LIMITS.defaultDays;
  }
  return value;
}

function normalizeTimeout(value: unknown, fields: DomainExpiryFieldErrors): number {
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < DOMAIN_EXPIRY_TIMEOUT_LIMITS.minimumMs ||
    value > DOMAIN_EXPIRY_TIMEOUT_LIMITS.maximumMs
  ) {
    fields.timeoutMs = [
      `Timeout must be from ${DOMAIN_EXPIRY_TIMEOUT_LIMITS.minimumMs} to ${DOMAIN_EXPIRY_TIMEOUT_LIMITS.maximumMs} milliseconds.`,
    ];
    return DOMAIN_EXPIRY_TIMEOUT_LIMITS.defaultMs;
  }
  return value;
}
