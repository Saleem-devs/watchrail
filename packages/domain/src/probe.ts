export const PROBE_LOCATION_STATUSES = ['ACTIVE', 'DISABLED'] as const;
export const PROBE_AGENT_STATUSES = ['PENDING', 'ACTIVE', 'REVOKED'] as const;
export const PROBE_CREDENTIAL_STATUSES = ['ACTIVE', 'REVOKED'] as const;
export const PROBE_ATTEMPT_STATUSES = ['LEASED', 'SUBMITTED', 'EXPIRED', 'REJECTED'] as const;

export const LOCAL_PROBE_LOCATION = 'local';
export const HTTP_EXECUTION_POLICY_VERSION = 'http-v1';
export const TCP_EXECUTION_POLICY_VERSION = 'tcp-v1';
export const DNS_EXECUTION_POLICY_VERSION = 'dns-v1';
export const LEGACY_HTTP_ENGINE_VERSION = 'watchrail-http-v1';
export const HTTP_ENGINE_VERSION = 'watchrail-http-v2';
export const TCP_ENGINE_VERSION = 'watchrail-tcp-v1';
export const DNS_ENGINE_VERSION = 'watchrail-dns-v1';
export const SUPPORTED_HTTP_ENGINE_VERSIONS = [
  LEGACY_HTTP_ENGINE_VERSION,
  HTTP_ENGINE_VERSION,
] as const;
export const PROBE_LEASE_DURATION_MS = 30_000;
export const PROBE_MAX_EXECUTION_MS = 120_000;
export const PROBE_MAX_ATTEMPTS = 3;
export const PROBE_RECONCILIATION_BATCH_SIZE = 100;
export const PROBE_HEARTBEAT_INTERVAL_LIMITS = { minimumMs: 5_000, maximumMs: 60_000 } as const;
export type ProbeAgentHealth = 'NOT_CONNECTED' | 'ONLINE' | 'STALE' | 'OFFLINE' | 'REVOKED';

export function deriveProbeAgentHealth(input: {
  status: ProbeAgentStatus;
  lastHeartbeatAt: Date | null;
  heartbeatIntervalMs: number;
  now: Date;
}): ProbeAgentHealth {
  if (input.status === 'PENDING') return 'NOT_CONNECTED';
  if (input.status === 'REVOKED') return 'REVOKED';
  if (!input.lastHeartbeatAt) return 'OFFLINE';
  const age = Math.max(0, input.now.getTime() - input.lastHeartbeatAt.getTime());
  if (age <= input.heartbeatIntervalMs * 2) return 'ONLINE';
  if (age <= input.heartbeatIntervalMs * 4) return 'STALE';
  return 'OFFLINE';
}
// Remote clocks may drift slightly, but agent timestamps must remain tied to
// the authoritative execution window so they cannot rewrite incident history.
export const PROBE_RESULT_CLOCK_SKEW_MS = 60_000;

export type ProbeLocationStatus = (typeof PROBE_LOCATION_STATUSES)[number];
export type ProbeAgentStatus = (typeof PROBE_AGENT_STATUSES)[number];
export type ProbeCredentialStatus = (typeof PROBE_CREDENTIAL_STATUSES)[number];
export type ProbeAttemptStatus = (typeof PROBE_ATTEMPT_STATUSES)[number];

export function probeEngineSupports(
  agentEngineVersion: string,
  requiredEngineVersion: string,
): boolean {
  return (
    agentEngineVersion === requiredEngineVersion ||
    (agentEngineVersion === HTTP_ENGINE_VERSION &&
      requiredEngineVersion === LEGACY_HTTP_ENGINE_VERSION) ||
    (agentEngineVersion === TCP_ENGINE_VERSION &&
      (requiredEngineVersion === HTTP_ENGINE_VERSION ||
        requiredEngineVersion === LEGACY_HTTP_ENGINE_VERSION)) ||
    (agentEngineVersion === DNS_ENGINE_VERSION &&
      (requiredEngineVersion === TCP_ENGINE_VERSION ||
        requiredEngineVersion === HTTP_ENGINE_VERSION ||
        requiredEngineVersion === LEGACY_HTTP_ENGINE_VERSION))
  );
}

export function requiredEngineVersionsForAgent(agentEngineVersion: string): readonly string[] {
  if (agentEngineVersion === HTTP_ENGINE_VERSION) {
    return [HTTP_ENGINE_VERSION, LEGACY_HTTP_ENGINE_VERSION];
  }
  if (agentEngineVersion === TCP_ENGINE_VERSION) {
    return [TCP_ENGINE_VERSION, HTTP_ENGINE_VERSION, LEGACY_HTTP_ENGINE_VERSION];
  }
  if (agentEngineVersion === DNS_ENGINE_VERSION) {
    return [
      DNS_ENGINE_VERSION,
      TCP_ENGINE_VERSION,
      HTTP_ENGINE_VERSION,
      LEGACY_HTTP_ENGINE_VERSION,
    ];
  }
  return [agentEngineVersion];
}

export function agentEngineVersionsForRequirement(
  requiredEngineVersion: string,
): readonly string[] {
  if (requiredEngineVersion === LEGACY_HTTP_ENGINE_VERSION) {
    return [
      LEGACY_HTTP_ENGINE_VERSION,
      HTTP_ENGINE_VERSION,
      TCP_ENGINE_VERSION,
      DNS_ENGINE_VERSION,
    ];
  }
  if (requiredEngineVersion === HTTP_ENGINE_VERSION) {
    return [HTTP_ENGINE_VERSION, TCP_ENGINE_VERSION, DNS_ENGINE_VERSION];
  }
  if (requiredEngineVersion === TCP_ENGINE_VERSION) {
    return [TCP_ENGINE_VERSION, DNS_ENGINE_VERSION];
  }
  return [requiredEngineVersion];
}

export function isSupportedHttpEngineVersion(value: string | null): boolean {
  return (
    value !== null &&
    (value === TCP_ENGINE_VERSION ||
      value === DNS_ENGINE_VERSION ||
      SUPPORTED_HTTP_ENGINE_VERSIONS.some((version) => version === value))
  );
}

export function assertProbeEngineVersion(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/u.test(value)) {
    throw new InvalidProbeLocationIdentityError();
  }
}

export interface ProbeLocationIdentityV1 {
  contractVersion: 1;
  organizationId: string;
  locationId: string;
}

export class InvalidProbeLocationIdentityError extends Error {
  constructor() {
    super('Probe location identity is invalid.');
    this.name = 'InvalidProbeLocationIdentityError';
  }
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export function parseProbeLocationIdentity(value: unknown): ProbeLocationIdentityV1 {
  if (!hasExactKeys(value, ['contractVersion', 'locationId', 'organizationId'])) {
    throw new InvalidProbeLocationIdentityError();
  }
  if (value.contractVersion !== 1 || !isUuid(value.organizationId) || !isUuid(value.locationId)) {
    throw new InvalidProbeLocationIdentityError();
  }
  return {
    contractVersion: 1,
    organizationId: value.organizationId,
    locationId: value.locationId,
  };
}

export function probeAssignmentLocation(locationId: string | null): string {
  if (locationId === null) return LOCAL_PROBE_LOCATION;
  if (!isUuid(locationId)) throw new InvalidProbeLocationIdentityError();
  return locationId.toLowerCase();
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
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
