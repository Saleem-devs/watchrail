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

export interface ProbeClaimRequestV1 {
  contractVersion: 1;
  engineVersion: string;
}

export interface ProbeHeartbeatV1 {
  contractVersion: 1;
  engineVersion: string;
  heartbeatIntervalMs: number;
}

export interface HttpProbeExecutionConfigurationV1 {
  contractVersion: 1;
  assignmentId: string;
  attemptId: string;
  configurationVersionId: string;
  configurationVersionNumber: number;
  executionPolicyVersion: string;
  requiredEngineVersion: string;
  url: string;
  method: 'GET' | 'HEAD' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'OPTIONS';
  timeoutMs: number;
  followRedirects: boolean;
  statusPolicy: { type: 'ANY_2XX' } | { type: 'EXACT'; statusCodes: number[] };
  tlsPolicy?:
    { type: 'DISABLED' } | { type: 'MINIMUM_VALIDITY'; days: 1 | 2 | 3 | 7 | 14 | 30 | 60 };
  requestHeaders: Array<{ name: string; value: string }>;
  requestBody:
    | { type: 'NONE' }
    | { type: 'JSON'; value: string }
    | { type: 'FORM_URLENCODED'; fields: Array<{ name: string; value: string }> }
    | { type: 'RAW'; contentType: string; value: string };
  assertions: {
    headers: unknown[];
    textBody: unknown[];
    jsonBody: unknown[];
  };
}

export interface TcpProbeExecutionConfigurationV1 {
  contractVersion: 1;
  type: 'TCP';
  assignmentId: string;
  attemptId: string;
  configurationVersionId: string;
  configurationVersionNumber: number;
  executionPolicyVersion: string;
  requiredEngineVersion: string;
  host: string;
  port: number;
  timeoutMs: number;
}

export type ProbeExecutionConfigurationV1 =
  HttpProbeExecutionConfigurationV1 | TcpProbeExecutionConfigurationV1;

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

export function parseProbeClaimRequest(value: unknown): ProbeClaimRequestV1 {
  if (
    !hasExactKeys(value, ['contractVersion', 'engineVersion']) ||
    value.contractVersion !== PROBE_COORDINATOR_CONTRACT_VERSION ||
    !isVersion(value.engineVersion)
  ) {
    throw new InvalidProbeCoordinatorContractError();
  }
  return value as unknown as ProbeClaimRequestV1;
}

export function parseProbeHeartbeat(value: unknown): ProbeHeartbeatV1 {
  if (
    !hasExactKeys(value, ['contractVersion', 'engineVersion', 'heartbeatIntervalMs']) ||
    value.contractVersion !== PROBE_COORDINATOR_CONTRACT_VERSION ||
    !isVersion(value.engineVersion) ||
    !Number.isInteger(value.heartbeatIntervalMs) ||
    Number(value.heartbeatIntervalMs) < 5_000 ||
    Number(value.heartbeatIntervalMs) > 60_000
  ) {
    throw new InvalidProbeCoordinatorContractError();
  }
  return value as unknown as ProbeHeartbeatV1;
}

export function parseProbeExecutionConfiguration(value: unknown): ProbeExecutionConfigurationV1 {
  const tcpKeys = [
    'assignmentId',
    'attemptId',
    'configurationVersionId',
    'configurationVersionNumber',
    'contractVersion',
    'executionPolicyVersion',
    'host',
    'port',
    'requiredEngineVersion',
    'timeoutMs',
    'type',
  ];
  if (hasExactKeys(value, tcpKeys) && value.type === 'TCP') {
    if (
      value.contractVersion !== PROBE_COORDINATOR_CONTRACT_VERSION ||
      !isUuid(value.assignmentId) ||
      !isUuid(value.attemptId) ||
      !isUuid(value.configurationVersionId) ||
      !isPositiveInteger(value.configurationVersionNumber) ||
      !isVersion(value.executionPolicyVersion) ||
      !isVersion(value.requiredEngineVersion) ||
      typeof value.host !== 'string' ||
      value.host.length === 0 ||
      value.host.length > 253 ||
      !Number.isInteger(value.port) ||
      Number(value.port) < 1 ||
      Number(value.port) > 65_535 ||
      !Number.isInteger(value.timeoutMs) ||
      Number(value.timeoutMs) < 1_000 ||
      Number(value.timeoutMs) > 30_000
    ) {
      throw new InvalidProbeCoordinatorContractError();
    }
    return value as unknown as TcpProbeExecutionConfigurationV1;
  }
  const legacyKeys = [
    'assertions',
    'assignmentId',
    'attemptId',
    'configurationVersionId',
    'configurationVersionNumber',
    'contractVersion',
    'executionPolicyVersion',
    'followRedirects',
    'method',
    'requestHeaders',
    'requestBody',
    'requiredEngineVersion',
    'statusPolicy',
    'timeoutMs',
    'url',
  ];
  const currentKeys = [...legacyKeys, 'tlsPolicy'];
  if (
    (!hasExactKeys(value, legacyKeys) && !hasExactKeys(value, currentKeys)) ||
    value.contractVersion !== PROBE_COORDINATOR_CONTRACT_VERSION ||
    !isUuid(value.assignmentId) ||
    !isUuid(value.attemptId) ||
    !isUuid(value.configurationVersionId) ||
    !isPositiveInteger(value.configurationVersionNumber) ||
    !isVersion(value.executionPolicyVersion) ||
    !isVersion(value.requiredEngineVersion) ||
    typeof value.url !== 'string' ||
    value.url.length === 0 ||
    value.url.length > 2048 ||
    !isHttpMethod(value.method) ||
    !Number.isInteger(value.timeoutMs) ||
    Number(value.timeoutMs) < 1_000 ||
    Number(value.timeoutMs) > 30_000 ||
    typeof value.followRedirects !== 'boolean' ||
    !isStatusPolicy(value.statusPolicy) ||
    (Object.hasOwn(value, 'tlsPolicy') && !isTlsPolicy(value.tlsPolicy)) ||
    !isRuntimeHeaders(value.requestHeaders) ||
    !isRequestBody(value.requestBody) ||
    !isRuntimeAssertions(value.assertions)
  ) {
    throw new InvalidProbeCoordinatorContractError();
  }
  return {
    ...(value as unknown as HttpProbeExecutionConfigurationV1),
    tlsPolicy: Object.hasOwn(value, 'tlsPolicy')
      ? (value.tlsPolicy as NonNullable<HttpProbeExecutionConfigurationV1['tlsPolicy']>)
      : { type: 'DISABLED' },
  };
}

function isTlsPolicy(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !('type' in value))
    return false;
  const policy = value as Record<string, unknown>;
  if (policy.type === 'DISABLED') return hasExactKeys(policy, ['type']);
  return (
    policy.type === 'MINIMUM_VALIDITY' &&
    hasExactKeys(policy, ['days', 'type']) &&
    [1, 2, 3, 7, 14, 30, 60].includes(Number(policy.days))
  );
}

function isRequestBody(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !('type' in value))
    return false;
  const body = value as Record<string, unknown>;
  if (body.type === 'NONE') return hasExactKeys(body, ['type']);
  if (body.type === 'JSON')
    return hasExactKeys(body, ['type', 'value']) && typeof body.value === 'string';
  if (body.type === 'RAW') {
    return (
      hasExactKeys(body, ['contentType', 'type', 'value']) &&
      typeof body.contentType === 'string' &&
      typeof body.value === 'string'
    );
  }
  return (
    body.type === 'FORM_URLENCODED' &&
    hasExactKeys(body, ['fields', 'type']) &&
    Array.isArray(body.fields) &&
    body.fields.every(
      (field) =>
        hasExactKeys(field, ['name', 'value']) &&
        typeof field.name === 'string' &&
        typeof field.value === 'string',
    )
  );
}

function isHttpMethod(
  value: unknown,
): value is 'GET' | 'HEAD' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'OPTIONS' {
  return (
    value === 'GET' ||
    value === 'HEAD' ||
    value === 'POST' ||
    value === 'PUT' ||
    value === 'PATCH' ||
    value === 'DELETE' ||
    value === 'OPTIONS'
  );
}

function isStatusPolicy(value: unknown): boolean {
  if (
    !hasExactKeys(
      value,
      value && typeof value === 'object' && 'type' in value && value.type === 'EXACT'
        ? ['statusCodes', 'type']
        : ['type'],
    )
  )
    return false;
  if (value.type === 'ANY_2XX') return true;
  return (
    value.type === 'EXACT' &&
    Array.isArray(value.statusCodes) &&
    value.statusCodes.length > 0 &&
    value.statusCodes.every(
      (code) => Number.isInteger(code) && Number(code) >= 100 && Number(code) <= 599,
    )
  );
}

function isRuntimeHeaders(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.every(
      (header) =>
        hasExactKeys(header, ['name', 'value']) &&
        typeof header.name === 'string' &&
        typeof header.value === 'string',
    )
  );
}

function isRuntimeAssertions(value: unknown): boolean {
  return (
    hasExactKeys(value, ['headers', 'jsonBody', 'textBody']) &&
    Array.isArray(value.headers) &&
    Array.isArray(value.textBody) &&
    Array.isArray(value.jsonBody)
  );
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
