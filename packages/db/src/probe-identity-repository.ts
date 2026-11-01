import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import type { WatchrailDatabase } from './client.js';
import {
  isSupportedHttpEngineVersion,
  deriveProbeAgentHealth,
  type ProbeAgentHealth,
} from '@watchrail/domain';
import {
  probeAgentCredentials,
  probeAgentEnrollments,
  probeAgents,
  probeLocations,
  type ProbeAgentRecord,
  type ProbeLocationRecord,
} from './schema.js';

export interface ProbeMachineIdentity {
  agentId: string;
  organizationId: string;
  locationId: string;
  credentialId: string;
  credentialVersion: number;
}

export interface ProbeEnrollmentRecord {
  id: string;
  organizationId: string;
  locationId: string;
  agentName: string;
  expiresAt: Date;
  consumedAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
}

export interface ProbeAgentHealthRecord extends ProbeAgentRecord {
  health: ProbeAgentHealth;
  engineCompatible: boolean;
}

export interface ProbeLocationHealthRecord extends ProbeLocationRecord {
  health: 'NOT_CONNECTED' | 'ONLINE' | 'STALE' | 'OFFLINE' | 'DISABLED';
  activeAgentCount: number;
}

export class ProbeIdentityNotFoundError extends Error {}
export class ProbeLocationUnavailableError extends Error {}
export class ProbeEnrollmentUnavailableError extends Error {}
export class ProbeAuthenticationError extends Error {}

export class ProbeIdentityRepository {
  constructor(private readonly db: WatchrailDatabase) {}

  async createLocation(
    organizationId: string,
    input: { name: string; slug: string },
  ): Promise<ProbeLocationRecord> {
    const [created] = await this.db
      .insert(probeLocations)
      .values({ organizationId, ...input })
      .returning();
    if (!created) throw new Error('Probe location insert returned no record.');
    return created;
  }

  listLocations(organizationId: string): Promise<ProbeLocationRecord[]> {
    return this.db
      .select()
      .from(probeLocations)
      .where(eq(probeLocations.organizationId, organizationId))
      .orderBy(asc(probeLocations.createdAt), asc(probeLocations.id));
  }

  async listLocationHealth(organizationId: string): Promise<ProbeLocationHealthRecord[]> {
    const [locations, agents, clock] = await Promise.all([
      this.listLocations(organizationId),
      this.listAgents(organizationId),
      this.databaseNow(),
    ]);
    return locations.map((location) => {
      const active = agents.filter(
        (agent) =>
          agent.locationId === location.id &&
          agent.status === 'ACTIVE' &&
          isSupportedHttpEngineVersion(agent.engineVersion),
      );
      const healths = active.map((agent) =>
        deriveProbeAgentHealth({
          status: agent.status,
          lastHeartbeatAt: agent.lastHeartbeatAt,
          heartbeatIntervalMs: agent.heartbeatIntervalMs,
          now: clock,
        }),
      );
      const health =
        location.status === 'DISABLED'
          ? 'DISABLED'
          : healths.includes('ONLINE')
            ? 'ONLINE'
            : healths.includes('STALE')
              ? 'STALE'
              : active.length > 0
                ? 'OFFLINE'
                : 'NOT_CONNECTED';
      return { ...location, health, activeAgentCount: active.length };
    });
  }

  async setLocationStatus(
    organizationId: string,
    locationId: string,
    status: 'ACTIVE' | 'DISABLED',
  ): Promise<ProbeLocationRecord> {
    const [updated] = await this.db
      .update(probeLocations)
      .set({ status, updatedAt: sql`clock_timestamp()` })
      .where(
        and(eq(probeLocations.organizationId, organizationId), eq(probeLocations.id, locationId)),
      )
      .returning();
    if (!updated) throw new ProbeIdentityNotFoundError();
    return updated;
  }

  async issueEnrollment(
    organizationId: string,
    locationId: string,
    agentName: string,
    tokenVerifier: string,
    ttlSeconds: number,
  ): Promise<ProbeEnrollmentRecord> {
    return this.db.transaction(async (tx) => {
      const [location] = await tx
        .select({ status: probeLocations.status })
        .from(probeLocations)
        .where(
          and(eq(probeLocations.organizationId, organizationId), eq(probeLocations.id, locationId)),
        )
        .limit(1)
        .for('update');
      if (!location) throw new ProbeIdentityNotFoundError();
      if (location.status !== 'ACTIVE') throw new ProbeLocationUnavailableError();
      const [created] = await tx
        .insert(probeAgentEnrollments)
        .values({
          organizationId,
          locationId,
          agentName,
          tokenVerifier,
          expiresAt: sql`clock_timestamp() + (${ttlSeconds} * interval '1 second')`,
        })
        .returning();
      if (!created) throw new Error('Probe enrollment insert returned no record.');
      return created;
    });
  }

  async revokeEnrollment(organizationId: string, enrollmentId: string): Promise<void> {
    const [revoked] = await this.db
      .update(probeAgentEnrollments)
      .set({ revokedAt: sql`clock_timestamp()` })
      .where(
        and(
          eq(probeAgentEnrollments.organizationId, organizationId),
          eq(probeAgentEnrollments.id, enrollmentId),
          isNull(probeAgentEnrollments.consumedAt),
          isNull(probeAgentEnrollments.revokedAt),
        ),
      )
      .returning({ id: probeAgentEnrollments.id });
    if (!revoked) throw new ProbeIdentityNotFoundError();
  }

  async enroll(
    enrollmentId: string,
    tokenVerifier: string,
    credentialVerifier: string,
  ): Promise<ProbeMachineIdentity> {
    return this.db.transaction(async (tx) => {
      const [enrollment] = await tx
        .select({
          id: probeAgentEnrollments.id,
          organizationId: probeAgentEnrollments.organizationId,
          locationId: probeAgentEnrollments.locationId,
          agentName: probeAgentEnrollments.agentName,
          tokenVerifier: probeAgentEnrollments.tokenVerifier,
          unexpired: sql<boolean>`${probeAgentEnrollments.expiresAt} > clock_timestamp()`,
          consumedAt: probeAgentEnrollments.consumedAt,
          revokedAt: probeAgentEnrollments.revokedAt,
          locationStatus: probeLocations.status,
        })
        .from(probeAgentEnrollments)
        .innerJoin(
          probeLocations,
          and(
            eq(probeLocations.organizationId, probeAgentEnrollments.organizationId),
            eq(probeLocations.id, probeAgentEnrollments.locationId),
          ),
        )
        .where(eq(probeAgentEnrollments.id, enrollmentId))
        .limit(1)
        .for('update');
      if (
        !enrollment ||
        enrollment.tokenVerifier !== tokenVerifier ||
        enrollment.consumedAt !== null ||
        enrollment.revokedAt !== null ||
        enrollment.locationStatus !== 'ACTIVE' ||
        !enrollment.unexpired
      ) {
        throw new ProbeEnrollmentUnavailableError();
      }
      const [agent] = await tx
        .insert(probeAgents)
        .values({
          organizationId: enrollment.organizationId,
          locationId: enrollment.locationId,
          name: enrollment.agentName,
          status: 'ACTIVE',
        })
        .returning();
      if (!agent) throw new Error('Probe agent insert returned no record.');
      const [credential] = await tx
        .insert(probeAgentCredentials)
        .values({
          organizationId: agent.organizationId,
          agentId: agent.id,
          versionNumber: 1,
          verifier: credentialVerifier,
        })
        .returning();
      if (!credential) throw new Error('Probe credential insert returned no record.');
      await tx
        .update(probeAgentEnrollments)
        .set({ consumedAt: sql`clock_timestamp()`, consumedByAgentId: agent.id })
        .where(eq(probeAgentEnrollments.id, enrollment.id));
      return identity(agent, credential.id, credential.versionNumber);
    });
  }

  async authenticate(credentialVerifier: string): Promise<ProbeMachineIdentity> {
    const [record] = await this.db
      .select({
        agentId: probeAgents.id,
        organizationId: probeAgents.organizationId,
        locationId: probeAgents.locationId,
        agentStatus: probeAgents.status,
        locationStatus: probeLocations.status,
        credentialId: probeAgentCredentials.id,
        credentialVersion: probeAgentCredentials.versionNumber,
        credentialStatus: probeAgentCredentials.status,
      })
      .from(probeAgentCredentials)
      .innerJoin(
        probeAgents,
        and(
          eq(probeAgents.organizationId, probeAgentCredentials.organizationId),
          eq(probeAgents.id, probeAgentCredentials.agentId),
        ),
      )
      .innerJoin(
        probeLocations,
        and(
          eq(probeLocations.organizationId, probeAgents.organizationId),
          eq(probeLocations.id, probeAgents.locationId),
        ),
      )
      .where(eq(probeAgentCredentials.verifier, credentialVerifier))
      .limit(1);
    if (
      !record ||
      record.credentialStatus !== 'ACTIVE' ||
      record.agentStatus !== 'ACTIVE' ||
      record.locationStatus !== 'ACTIVE'
    ) {
      throw new ProbeAuthenticationError();
    }
    return record;
  }

  async rotateCredential(
    machine: ProbeMachineIdentity,
    replacementVerifier: string,
  ): Promise<ProbeMachineIdentity> {
    return this.db.transaction(async (tx) => {
      const [agent] = await tx
        .select({
          status: probeAgents.status,
          locationStatus: probeLocations.status,
        })
        .from(probeAgents)
        .innerJoin(
          probeLocations,
          and(
            eq(probeLocations.organizationId, probeAgents.organizationId),
            eq(probeLocations.id, probeAgents.locationId),
          ),
        )
        .where(
          and(
            eq(probeAgents.organizationId, machine.organizationId),
            eq(probeAgents.id, machine.agentId),
            eq(probeAgents.locationId, machine.locationId),
          ),
        )
        .limit(1)
        .for('update', { of: probeAgents });
      if (!agent || agent.status !== 'ACTIVE' || agent.locationStatus !== 'ACTIVE') {
        throw new ProbeAuthenticationError();
      }

      const [current] = await tx
        .select({
          status: probeAgentCredentials.status,
        })
        .from(probeAgentCredentials)
        .where(
          and(
            eq(probeAgentCredentials.organizationId, machine.organizationId),
            eq(probeAgentCredentials.id, machine.credentialId),
            eq(probeAgentCredentials.agentId, machine.agentId),
          ),
        )
        .limit(1)
        .for('update', { of: probeAgentCredentials });
      if (!current || current.status !== 'ACTIVE') {
        throw new ProbeAuthenticationError();
      }
      await tx
        .update(probeAgentCredentials)
        .set({ status: 'REVOKED', revokedAt: sql`clock_timestamp()` })
        .where(eq(probeAgentCredentials.id, machine.credentialId));
      const [replacement] = await tx
        .insert(probeAgentCredentials)
        .values({
          organizationId: machine.organizationId,
          agentId: machine.agentId,
          versionNumber: machine.credentialVersion + 1,
          verifier: replacementVerifier,
        })
        .returning();
      if (!replacement) throw new Error('Probe credential rotation returned no record.');
      return {
        ...machine,
        credentialId: replacement.id,
        credentialVersion: replacement.versionNumber,
      };
    });
  }

  listAgents(organizationId: string): Promise<ProbeAgentRecord[]> {
    return this.db
      .select()
      .from(probeAgents)
      .where(eq(probeAgents.organizationId, organizationId))
      .orderBy(asc(probeAgents.createdAt), asc(probeAgents.id));
  }

  async listAgentHealth(organizationId: string): Promise<ProbeAgentHealthRecord[]> {
    const [agents, now] = await Promise.all([this.listAgents(organizationId), this.databaseNow()]);
    return agents.map((agent) => ({
      ...agent,
      health: deriveProbeAgentHealth({
        status: agent.status,
        lastHeartbeatAt: agent.lastHeartbeatAt,
        heartbeatIntervalMs: agent.heartbeatIntervalMs,
        now,
      }),
      engineCompatible: isSupportedHttpEngineVersion(agent.engineVersion),
    }));
  }

  private async databaseNow(): Promise<Date> {
    const result = await this.db.execute<{ now: string }>(
      sql`select date_trunc('milliseconds', clock_timestamp()) as now`,
    );
    const now = result.rows[0]?.now;
    if (!now) throw new Error('Database clock returned no value.');
    return new Date(now);
  }

  async revokeAgent(organizationId: string, agentId: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      const [agent] = await tx
        .select({ id: probeAgents.id })
        .from(probeAgents)
        .where(and(eq(probeAgents.organizationId, organizationId), eq(probeAgents.id, agentId)))
        .limit(1)
        .for('update', { of: probeAgents });
      if (!agent) throw new ProbeIdentityNotFoundError();

      await tx
        .update(probeAgents)
        .set({
          status: 'REVOKED',
          revokedAt: sql`clock_timestamp()`,
          updatedAt: sql`clock_timestamp()`,
        })
        .where(and(eq(probeAgents.organizationId, organizationId), eq(probeAgents.id, agentId)))
        .returning({ id: probeAgents.id });
      await tx
        .update(probeAgentCredentials)
        .set({ status: 'REVOKED', revokedAt: sql`clock_timestamp()` })
        .where(
          and(
            eq(probeAgentCredentials.organizationId, organizationId),
            eq(probeAgentCredentials.agentId, agentId),
            eq(probeAgentCredentials.status, 'ACTIVE'),
          ),
        );
    });
  }
}

function identity(
  agent: Pick<ProbeAgentRecord, 'id' | 'organizationId' | 'locationId'>,
  credentialId: string,
  credentialVersion: number,
): ProbeMachineIdentity {
  return {
    agentId: agent.id,
    organizationId: agent.organizationId,
    locationId: agent.locationId,
    credentialId,
    credentialVersion,
  };
}
