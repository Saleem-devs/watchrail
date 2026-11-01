export const TLS_EXPIRY_THRESHOLDS_DAYS = [1, 2, 3, 7, 14, 30, 60] as const;

export type TlsExpiryThresholdDays = (typeof TLS_EXPIRY_THRESHOLDS_DAYS)[number];

export type TlsCertificatePolicy =
  { type: 'DISABLED' } | { type: 'MINIMUM_VALIDITY'; days: TlsExpiryThresholdDays };

export interface TlsCertificateEvidenceV1 {
  contractVersion: 1;
  origin: string;
  hostname: string;
  validFrom: string;
  validTo: string;
  fingerprint256: string;
  subject: string;
  issuer: string;
  protocol: string;
  cipher: string;
}

export const DISABLED_TLS_CERTIFICATE_POLICY = Object.freeze({
  type: 'DISABLED',
} as const satisfies TlsCertificatePolicy);

export class TlsCertificatePolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TlsCertificatePolicyError';
  }
}

export function parseTlsCertificatePolicy(value: unknown): TlsCertificatePolicy {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TlsCertificatePolicyError('Choose a valid TLS certificate policy.');
  }
  const policy = value as Record<string, unknown>;
  if (policy.type === 'DISABLED' && hasExactKeys(policy, ['type'])) {
    return { type: 'DISABLED' };
  }
  if (
    policy.type === 'MINIMUM_VALIDITY' &&
    hasExactKeys(policy, ['days', 'type']) &&
    TLS_EXPIRY_THRESHOLDS_DAYS.includes(policy.days as TlsExpiryThresholdDays)
  ) {
    return { type: 'MINIMUM_VALIDITY', days: policy.days as TlsExpiryThresholdDays };
  }
  throw new TlsCertificatePolicyError(
    `Choose disabled or a certificate warning threshold of ${TLS_EXPIRY_THRESHOLDS_DAYS.join(', ')} days.`,
  );
}

export function parseTlsCertificateEvidence(value: unknown): TlsCertificateEvidenceV1 {
  if (
    !hasExactKeys(value, [
      'cipher',
      'contractVersion',
      'fingerprint256',
      'hostname',
      'issuer',
      'origin',
      'protocol',
      'subject',
      'validFrom',
      'validTo',
    ]) ||
    value.contractVersion !== 1 ||
    !isHttpsOrigin(value.origin) ||
    !boundedString(value.hostname, 253) ||
    !canonicalTimestamp(value.validFrom) ||
    !canonicalTimestamp(value.validTo) ||
    Date.parse(value.validTo) <= Date.parse(value.validFrom) ||
    !/^(?:[0-9A-F]{2}:){31}[0-9A-F]{2}$/u.test(String(value.fingerprint256)) ||
    !boundedString(value.subject, 1_024) ||
    !boundedString(value.issuer, 1_024) ||
    !boundedString(value.protocol, 32) ||
    !boundedString(value.cipher, 128)
  ) {
    throw new TlsCertificatePolicyError('TLS certificate evidence is invalid.');
  }
  return Object.freeze({ ...value }) as unknown as TlsCertificateEvidenceV1;
}

export function parseTlsCertificateEvidenceList(value: unknown): TlsCertificateEvidenceV1[] {
  if (!Array.isArray(value) || value.length > 6) {
    throw new TlsCertificatePolicyError('TLS certificate evidence list is invalid.');
  }
  const parsed = value.map(parseTlsCertificateEvidence);
  const identities = new Set(parsed.map((item) => `${item.origin}\u0000${item.fingerprint256}`));
  if (identities.size !== parsed.length) {
    throw new TlsCertificatePolicyError('TLS certificate evidence must be unique.');
  }
  return parsed;
}

function isHttpsOrigin(value: unknown): value is string {
  if (!boundedString(value, 2_048)) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.origin === value;
  } catch {
    return false;
  }
}

function canonicalTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value;
}

function boundedString(value: unknown, limit: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= limit;
}

function hasExactKeys(
  value: unknown,
  expected: readonly string[],
): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value).sort();
  const required = [...expected].sort();
  return keys.length === required.length && keys.every((key, index) => key === required[index]);
}
