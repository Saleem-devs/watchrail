import { ConflictException, Logger } from '@nestjs/common';
import type { ProbeCoordinatorRepository, ProbeMachineIdentity } from '@watchrail/db';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppConfig } from './config.js';
import { ProbeCoordinatorService } from './probe-coordinator.service.js';

describe('ProbeCoordinatorService submission audit', () => {
  const machine: ProbeMachineIdentity = {
    organizationId: '11111111-1111-4111-8111-111111111111',
    locationId: '22222222-2222-4222-8222-222222222222',
    agentId: '33333333-3333-4333-8333-333333333333',
    credentialId: '44444444-4444-4444-8444-444444444444',
    credentialVersion: 1,
  };
  const assignmentId = '55555555-5555-4555-8555-555555555555';
  const attemptId = '66666666-6666-4666-8666-666666666666';
  const claimToken = 's'.repeat(43);
  let submit: ReturnType<typeof vi.fn>;
  let warn: ReturnType<typeof vi.spyOn>;
  let service: ProbeCoordinatorService;

  beforeEach(() => {
    submit = vi.fn().mockResolvedValue({
      state: 'REJECTED',
      reason: 'NON_AUTHORITATIVE_LEASE',
    });
    warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    service = new ProbeCoordinatorService(
      { submit } as unknown as ProbeCoordinatorRepository,
      {} as AppConfig,
    );
  });

  it('emits an attributable value-free event while preserving the generic API rejection', async () => {
    await expect(
      service.submit(machine, attemptId, claimToken, {
        reference: {
          contractVersion: 1,
          assignmentId,
          attemptId,
          attemptNumber: 1,
          engineVersion: 'watchrail-http-v1',
        },
        result: {
          outcome: 'PASS',
          stage: 'HTTP',
          reason: 'COMPLETED',
          statusCode: 200,
          responseTimeMs: 12,
          attemptDurationMs: 15,
          redirects: [],
          assertionEvaluation: { contractVersion: 1, outcome: 'PASS', diagnostics: [] },
          checkedAt: new Date().toISOString(),
        },
      }),
    ).rejects.toBeInstanceOf(ConflictException);

    expect(warn).toHaveBeenCalledWith({
      event: 'probe_result_submission_rejected',
      organizationId: machine.organizationId,
      locationId: machine.locationId,
      agentId: machine.agentId,
      assignmentId,
      attemptId,
      reason: 'NON_AUTHORITATIVE_LEASE',
    });
    expect(JSON.stringify(warn.mock.calls)).not.toContain(claimToken);
  });
});
