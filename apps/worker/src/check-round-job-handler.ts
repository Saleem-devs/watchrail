import { Injectable, Logger } from '@nestjs/common';
import { executeHttpCheck } from '@watchrail/check-engine';
import type { HttpCheckResult, HttpExecutor } from '@watchrail/check-engine';
import type { ExecuteCheckRoundJobV1 } from '@watchrail/contracts';
import type { CheckExecutionRepository } from '@watchrail/db';
import type { CheckJobHandler } from '@watchrail/queue';
import {
  resolveRequestHeaders,
  type HeaderEncryptionKeyring,
} from '@watchrail/http-header-security';

export class CheckExecutionAlreadyClaimedError extends Error {
  constructor() {
    super('The check execution assignment is owned by another worker.');
    this.name = 'CheckExecutionAlreadyClaimedError';
  }
}

export class CheckExecutionClaimLostError extends Error {
  constructor() {
    super('The check execution claim was lost before completion.');
    this.name = 'CheckExecutionClaimLostError';
  }
}

@Injectable()
export class CheckRoundJobHandler implements CheckJobHandler {
  private readonly logger = new Logger(CheckRoundJobHandler.name);

  constructor(
    private readonly executions: CheckExecutionRepository,
    private readonly executor: HttpExecutor,
    private readonly leaseDurationMs: number,
    private readonly headerEncryptionKeyring: HeaderEncryptionKeyring,
  ) {}

  async handle(payload: ExecuteCheckRoundJobV1): Promise<void> {
    const claim = await this.executions.claim(payload.roundId, this.leaseDurationMs);

    if (claim.state === 'COMPLETED') return;

    if (claim.state === 'MISSING') {
      this.logger.warn(`No local execution assignment exists for round ${payload.roundId}.`);
      return;
    }

    if (claim.state === 'BUSY') {
      throw new CheckExecutionAlreadyClaimedError();
    }

    let result: HttpCheckResult = internalExecutionFailureResult();

    if (isSupportedMethod(claim.execution.method)) {
      let requestHeaders;
      try {
        requestHeaders = resolveRequestHeaders(
          claim.execution.requestHeaders,
          {
            organizationId: claim.execution.organizationId,
            monitorId: claim.execution.monitorId,
          },
          this.headerEncryptionKeyring,
        );
      } catch {
        this.logger.error(
          `Stored request-header configuration is invalid for assignment ${claim.execution.assignmentId}.`,
        );
      }

      if (requestHeaders !== undefined) {
        result = await executeHttpCheck(
          {
            url: claim.execution.url,
            method: claim.execution.method,
            timeoutMs: claim.execution.timeoutMs,
            statusPolicy: claim.execution.statusPolicy,
            requestHeaders,
          },
          { executor: this.executor },
        );
      }
    }

    const completed = await this.executions.complete(
      claim.execution.assignmentId,
      claim.execution.claimToken,
      result,
    );

    if (!completed) throw new CheckExecutionClaimLostError();
  }
}

function isSupportedMethod(method: string): method is 'GET' | 'HEAD' {
  return method === 'GET' || method === 'HEAD';
}

function internalExecutionFailureResult(): HttpCheckResult {
  return {
    outcome: 'UNKNOWN',
    stage: 'PROBE',
    reason: 'INTERNAL_ERROR',
    statusCode: null,
    responseTimeMs: null,
    attemptDurationMs: 0,
    checkedAt: new Date(),
  };
}
