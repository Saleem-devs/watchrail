import type {
  ProbeAgentHealthRecord,
  ProbeLocationHealthRecord,
  ProbeLocationRecord,
} from '@watchrail/db';
import type { ProbeMachineRequest } from './probe-machine-auth.js';

export function locationResponse(location: ProbeLocationRecord | ProbeLocationHealthRecord) {
  return {
    id: location.id,
    name: location.name,
    slug: location.slug,
    status: location.status,
    ...('health' in location
      ? { health: location.health, activeAgentCount: location.activeAgentCount }
      : {}),
    createdAt: location.createdAt.toISOString(),
    updatedAt: location.updatedAt.toISOString(),
  };
}

export function agentResponse(agent: ProbeAgentHealthRecord) {
  return {
    id: agent.id,
    locationId: agent.locationId,
    name: agent.name,
    status: agent.status,
    lastHeartbeatAt: agent.lastHeartbeatAt?.toISOString() ?? null,
    engineVersion: agent.engineVersion,
    heartbeatIntervalMs: agent.heartbeatIntervalMs,
    health: agent.health,
    engineCompatible: agent.engineCompatible,
    createdAt: agent.createdAt.toISOString(),
    updatedAt: agent.updatedAt.toISOString(),
  };
}

export function machineResponse(identity: ProbeMachineRequest['probeMachineIdentity']) {
  return {
    agentId: identity.agentId,
    organizationId: identity.organizationId,
    locationId: identity.locationId,
    credentialVersion: identity.credentialVersion,
  };
}
