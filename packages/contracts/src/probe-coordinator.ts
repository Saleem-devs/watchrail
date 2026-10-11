export const PROBE_COORDINATOR_CONTRACT_VERSION = 1;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const VERSION_PATTERN = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/u;

export interface ProbeLeaseReferenceV1 {
  contractVersion: 1;
  organizationId: string;
  locationId: string;
  assignmentId: string;
  attemptId: string;
  attemptNumber: number;
  claimToken: string;
  configurationVersionId: string;
  configurationVersionNumber: number;
  executionPolicyVersion: string;
  requiredEngineVersion: string;
  leaseExpiresAt: string;
}

export interface ProbeResultSubmissionReferenceV1 {
  contractVersion: 1;
  assignmentId: string;
  attemptId: string;
  attemptNumber: number;
  engineVersion: string;
}

export class InvalidProbeCoordinatorContractError extends Error {
  constructor() {
    super('Probe coordinator contract is invalid.');
    this.name = 'InvalidProbeCoordinatorContractError';
  }
}

export function parseProbeLeaseReference(value: unknown): ProbeLeaseReferenceV1 {
  if (
    !hasExactKeys(value, [
      'assignmentId',
      'attemptId',
      'attemptNumber',
      'claimToken',
      'configurationVersionId',
      'configurationVersionNumber',
      'contractVersion',
      'executionPolicyVersion',
      'leaseExpiresAt',
      'locationId',
      'organizationId',
      'requiredEngineVersion',
    ]) ||
    value.contractVersion !== PROBE_COORDINATOR_CONTRACT_VERSION ||
    !isUuid(value.organizationId) ||
    !isUuid(value.locationId) ||
    !isUuid(value.assignmentId) ||
    !isUuid(value.attemptId) ||
    !isPositiveInteger(value.attemptNumber) ||
    !isSecret(value.claimToken) ||
    !isUuid(value.configurationVersionId) ||
    !isPositiveInteger(value.configurationVersionNumber) ||
    !isVersion(value.executionPolicyVersion) ||
    !isVersion(value.requiredEngineVersion) ||
    !isCanonicalTimestamp(value.leaseExpiresAt)
  ) {
    throw new InvalidProbeCoordinatorContractError();
  }
  return value as unknown as ProbeLeaseReferenceV1;
}

export function parseProbeResultSubmissionReference(
  value: unknown,
): ProbeResultSubmissionReferenceV1 {
  if (
    !hasExactKeys(value, [
      'assignmentId',
      'attemptId',
      'attemptNumber',
      'contractVersion',
      'engineVersion',
    ]) ||
    value.contractVersion !== PROBE_COORDINATOR_CONTRACT_VERSION ||
    !isUuid(value.assignmentId) ||
    !isUuid(value.attemptId) ||
    !isPositiveInteger(value.attemptNumber) ||
    !isVersion(value.engineVersion)
  ) {
    throw new InvalidProbeCoordinatorContractError();
  }
  return value as unknown as ProbeResultSubmissionReferenceV1;
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function isVersion(value: unknown): value is string {
  return typeof value === 'string' && VERSION_PATTERN.test(value);
}

function isSecret(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/u.test(value);
}

function isCanonicalTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString() === value;
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
