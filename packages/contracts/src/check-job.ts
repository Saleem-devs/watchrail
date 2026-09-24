export const CHECK_EXECUTION_QUEUE = 'check-execution';
export const EXECUTE_CHECK_ROUND_JOB = 'execute-check-round';
export const EXECUTE_CHECK_ROUND_CONTRACT_VERSION = 1;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface ExecuteCheckRoundJobV1 {
  contractVersion: typeof EXECUTE_CHECK_ROUND_CONTRACT_VERSION;
  roundId: string;
}

export class InvalidExecuteCheckRoundJobError extends Error {
  constructor() {
    super('Execute-check-round job payload is invalid.');
    this.name = 'InvalidExecuteCheckRoundJobError';
  }
}

export function createExecuteCheckRoundJob(roundId: string): ExecuteCheckRoundJobV1 {
  assertUuid(roundId);

  return {
    contractVersion: EXECUTE_CHECK_ROUND_CONTRACT_VERSION,
    roundId,
  };
}

export function parseExecuteCheckRoundJob(value: unknown): ExecuteCheckRoundJobV1 {
  if (!isRecord(value)) {
    throw new InvalidExecuteCheckRoundJobError();
  }

  const keys = Object.keys(value);

  if (
    keys.length !== 2 ||
    !Object.hasOwn(value, 'contractVersion') ||
    !Object.hasOwn(value, 'roundId') ||
    value.contractVersion !== EXECUTE_CHECK_ROUND_CONTRACT_VERSION ||
    typeof value.roundId !== 'string' ||
    !UUID_PATTERN.test(value.roundId)
  ) {
    throw new InvalidExecuteCheckRoundJobError();
  }

  return {
    contractVersion: EXECUTE_CHECK_ROUND_CONTRACT_VERSION,
    roundId: value.roundId,
  };
}

export function checkRoundJobId(roundId: string): string {
  assertUuid(roundId);
  return `check-round-${roundId}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertUuid(value: string): void {
  if (!UUID_PATTERN.test(value)) {
    throw new InvalidExecuteCheckRoundJobError();
  }
}
