import { describe, expect, it, vi } from 'vitest';
import type { HttpExecutor } from '@watchrail/check-engine';
import type { CheckExecutionRepository } from '@watchrail/db';
import {
  CheckExecutionAlreadyClaimedError,
  CheckExecutionClaimLostError,
  CheckRoundJobHandler,
} from './check-round-job-handler.js';

const payload = {
  contractVersion: 1,
  roundId: '11111111-1111-4111-8111-111111111111',
} as const;

const claimedExecution = {
  assignmentId: '22222222-2222-4222-8222-222222222222',
  claimToken: '33333333-3333-4333-8333-333333333333',
  attemptNumber: 1,
  url: 'https://example.com/health',
  method: 'GET',
  timeoutMs: 10_000,
  statusPolicy: { type: 'ANY_2XX' },
} as const;

function createDependencies() {
  const claim = vi.fn<CheckExecutionRepository['claim']>();
  const complete = vi.fn<CheckExecutionRepository['complete']>();
  const execute = vi.fn<HttpExecutor['execute']>();
  const executions = {
    claim: (roundId: string, leaseDurationMs: number) => claim(roundId, leaseDurationMs),
    complete: (
      assignmentId: string,
      claimToken: string,
      result: Parameters<CheckExecutionRepository['complete']>[2],
    ) => complete(assignmentId, claimToken, result),
  } as unknown as CheckExecutionRepository;
  const executor: HttpExecutor = {
    execute: (input) => execute(input),
  };

  return { executions, executor, claim, complete, execute };
}

describe('CheckRoundJobHandler', () => {
  it('executes a claimed HTTP check and persists its normalized result', async () => {
    const { executions, executor, claim, complete, execute } = createDependencies();
    claim.mockResolvedValue({
      state: 'CLAIMED',
      execution: claimedExecution,
    });
    execute.mockResolvedValue({
      type: 'RESPONSE',
      statusCode: 200,
      responseTimeMs: 12,
    });
    complete.mockResolvedValue(true);

    await new CheckRoundJobHandler(executions, executor, 45_000).handle(payload);

    expect(claim).toHaveBeenCalledWith(payload.roundId, 45_000);
    expect(complete).toHaveBeenCalledWith(
      claimedExecution.assignmentId,
      claimedExecution.claimToken,
      expect.objectContaining({
        outcome: 'PASS',
        stage: 'HTTP',
        reason: 'COMPLETED',
        statusCode: 200,
        responseTimeMs: 12,
      }),
    );
  });

  it('evaluates the immutable exact status policy before persisting', async () => {
    const { executions, executor, claim, complete, execute } = createDependencies();
    claim.mockResolvedValue({
      state: 'CLAIMED',
      execution: {
        ...claimedExecution,
        statusPolicy: { type: 'EXACT', statusCodes: [404] },
      },
    });
    execute.mockResolvedValue({ type: 'RESPONSE', statusCode: 404, responseTimeMs: 12 });
    complete.mockResolvedValue(true);

    await new CheckRoundJobHandler(executions, executor, 45_000).handle(payload);

    expect(complete).toHaveBeenCalledWith(
      claimedExecution.assignmentId,
      claimedExecution.claimToken,
      expect.objectContaining({ outcome: 'PASS', statusCode: 404 }),
    );
  });

  it('treats a completed assignment as an idempotent replay', async () => {
    const { executions, executor, claim, complete, execute } = createDependencies();
    claim.mockResolvedValue({ state: 'COMPLETED' });

    await new CheckRoundJobHandler(executions, executor, 45_000).handle(payload);

    expect(execute).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
  });

  it('retries while another worker owns the assignment', async () => {
    const { executions, executor, claim } = createDependencies();
    claim.mockResolvedValue({ state: 'BUSY' });

    await expect(
      new CheckRoundJobHandler(executions, executor, 45_000).handle(payload),
    ).rejects.toBeInstanceOf(CheckExecutionAlreadyClaimedError);
  });

  it('retries when its database claim is replaced before completion', async () => {
    const { executions, executor, claim, complete, execute } = createDependencies();
    claim.mockResolvedValue({
      state: 'CLAIMED',
      execution: claimedExecution,
    });
    execute.mockResolvedValue({
      type: 'RESPONSE',
      statusCode: 503,
      responseTimeMs: 10,
    });
    complete.mockResolvedValue(false);

    await expect(
      new CheckRoundJobHandler(executions, executor, 45_000).handle(payload),
    ).rejects.toBeInstanceOf(CheckExecutionClaimLostError);
  });

  it('persists unsupported stored methods as an internal execution failure', async () => {
    const { executions, executor, claim, complete, execute } = createDependencies();
    claim.mockResolvedValue({
      state: 'CLAIMED',
      execution: { ...claimedExecution, method: 'POST' },
    });
    complete.mockResolvedValue(true);

    await new CheckRoundJobHandler(executions, executor, 45_000).handle(payload);

    expect(execute).not.toHaveBeenCalled();
    expect(complete).toHaveBeenCalledWith(
      claimedExecution.assignmentId,
      claimedExecution.claimToken,
      expect.objectContaining({
        outcome: 'UNKNOWN',
        stage: 'PROBE',
        reason: 'INTERNAL_ERROR',
      }),
    );
  });
});
