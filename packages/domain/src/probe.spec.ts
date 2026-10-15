import { describe, expect, it } from 'vitest';
import {
  InvalidProbeLocationIdentityError,
  deriveProbeAgentHealth,
  parseProbeLocationIdentity,
  probeAssignmentLocation,
} from './probe.js';

const organizationId = '11111111-1111-4111-8111-111111111111';
const locationId = '22222222-2222-4222-8222-222222222222';

describe('probe domain', () => {
  it('parses an exact tenant-scoped location identity', () => {
    expect(parseProbeLocationIdentity({ contractVersion: 1, organizationId, locationId })).toEqual({
      contractVersion: 1,
      organizationId,
      locationId,
    });
  });

  it('rejects unknown fields and malformed identities', () => {
    expect(() =>
      parseProbeLocationIdentity({ contractVersion: 1, organizationId, locationId, extra: true }),
    ).toThrow(InvalidProbeLocationIdentityError);
    expect(() =>
      parseProbeLocationIdentity({ contractVersion: 1, organizationId, locationId: 'local' }),
    ).toThrow(InvalidProbeLocationIdentityError);
  });

  it('uses the local sentinel only when no remote location is selected', () => {
    expect(probeAssignmentLocation(null)).toBe('local');
    expect(probeAssignmentLocation(locationId.toUpperCase())).toBe(locationId);
  });

  it('derives lifecycle-aware health from the configured heartbeat interval', () => {
    const now = new Date('2026-10-14T10:00:00.000Z');
    expect(
      deriveProbeAgentHealth({
        status: 'ACTIVE',
        lastHeartbeatAt: new Date(now.getTime() - 30_000),
        heartbeatIntervalMs: 15_000,
        now,
      }),
    ).toBe('ONLINE');
    expect(
      deriveProbeAgentHealth({
        status: 'ACTIVE',
        lastHeartbeatAt: new Date(now.getTime() - 60_000),
        heartbeatIntervalMs: 15_000,
        now,
      }),
    ).toBe('STALE');
    expect(
      deriveProbeAgentHealth({
        status: 'ACTIVE',
        lastHeartbeatAt: new Date(now.getTime() - 60_001),
        heartbeatIntervalMs: 15_000,
        now,
      }),
    ).toBe('OFFLINE');
    expect(
      deriveProbeAgentHealth({
        status: 'PENDING',
        lastHeartbeatAt: null,
        heartbeatIntervalMs: 15_000,
        now,
      }),
    ).toBe('NOT_CONNECTED');
    expect(
      deriveProbeAgentHealth({
        status: 'REVOKED',
        lastHeartbeatAt: now,
        heartbeatIntervalMs: 15_000,
        now,
      }),
    ).toBe('REVOKED');
  });
});
