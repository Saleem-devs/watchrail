import { BadRequestException, ConflictException, Logger } from '@nestjs/common';
import type {
  ProbeCoordinatorRepository,
  ProbeMachineIdentity,
  WorkspaceSecretRepository,
} from '@watchrail/db';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../../config/config.js';
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
  let configuration: ReturnType<typeof vi.fn>;
  let resolveWorkspaceSecret: ReturnType<typeof vi.fn>;
  let warn: ReturnType<typeof vi.spyOn>;
  let service: ProbeCoordinatorService;

  beforeEach(() => {
    configuration = vi.fn().mockResolvedValue(null);
    resolveWorkspaceSecret = vi.fn();
    submit = vi.fn().mockResolvedValue({
      state: 'REJECTED',
      reason: 'NON_AUTHORITATIVE_LEASE',
    });
    warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    service = new ProbeCoordinatorService(
      { configuration, submit } as unknown as ProbeCoordinatorRepository,
      {
        createExecutionValueResolver: vi.fn(() => resolveWorkspaceSecret),
      } as unknown as WorkspaceSecretRepository,
      {} as AppConfig,
    );
  });

  it('does not resolve workspace secrets for a rejected or expired lease', async () => {
    await expect(service.configuration(machine, attemptId, claimToken)).rejects.toBeInstanceOf(
      ConflictException,
    );

    expect(configuration).toHaveBeenCalledWith(machine, attemptId, claimToken);
    expect(resolveWorkspaceSecret).not.toHaveBeenCalled();
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

  it.each([
    ['NO_RECORDS', ['203.0.113.10']],
    ['RECORD_MISMATCH', [] as string[]],
    ['NAME_NOT_FOUND', ['203.0.113.10']],
  ])('rejects contradictory answer evidence for %s', async (reason, contradictoryAnswers) => {
    const classification =
      reason === 'NAME_NOT_FOUND'
        ? { outcome: 'FAIL', stage: 'DNS', queryTimeMs: null }
        : { outcome: 'FAIL', stage: 'DNS', queryTimeMs: 12 };
    await expect(
      service.submit(machine, attemptId, claimToken, {
        reference: {
          contractVersion: 1,
          assignmentId,
          attemptId,
          attemptNumber: 1,
          engineVersion: 'watchrail-dns-v1',
        },
        result: {
          ...classification,
          reason,
          answers: contradictoryAnswers,
          attemptDurationMs: 15,
          checkedAt: new Date().toISOString(),
        },
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(submit).not.toHaveBeenCalled();
  });

  it('accepts bounded workflow diagnostics and rejects injected response evidence', async () => {
    submit.mockResolvedValue({ state: 'ACCEPTED', duplicate: false });
    const checkedAt = new Date().toISOString();
    const workflowResult = {
      outcome: 'PASS',
      stage: 'WORKFLOW',
      reason: 'WORKFLOW_COMPLETED',
      failedStepId: null,
      checkedAt,
      attemptDurationMs: 20,
      steps: ['first', 'second'].map((id, position) => ({
        id,
        name: id,
        position,
        status: 'EXECUTED',
        result: {
          outcome: 'PASS',
          stage: 'HTTP',
          reason: 'COMPLETED',
          statusCode: 200,
          responseTimeMs: 8,
          attemptDurationMs: 10,
          checkedAt,
          assertionEvaluation: { contractVersion: 1, outcome: 'PASS', diagnostics: [] },
          redirectCount: 0,
          tlsCertificateCount: 0,
        },
        extractions: [],
      })),
    };
    const body = {
      reference: {
        contractVersion: 1,
        assignmentId,
        attemptId,
        attemptNumber: 1,
        engineVersion: 'watchrail-api-workflow-v1',
      },
      result: workflowResult,
    };

    await expect(service.submit(machine, attemptId, claimToken, body)).resolves.toEqual({
      state: 'ACCEPTED',
      duplicate: false,
    });
    expect(submit).toHaveBeenCalledWith(
      machine,
      expect.objectContaining({ engineVersion: 'watchrail-api-workflow-v1' }),
      claimToken,
      expect.objectContaining({
        stage: 'WORKFLOW',
        workflowResult: expect.objectContaining({ reason: 'WORKFLOW_COMPLETED' }),
      }),
    );

    const firstStep = workflowResult.steps[0]!;
    await expect(
      service.submit(machine, attemptId, claimToken, {
        ...body,
        result: {
          ...workflowResult,
          steps: [
            { ...firstStep, result: { ...firstStep.result, responseEvidence: 'secret' } },
            workflowResult.steps[1],
          ],
        },
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
