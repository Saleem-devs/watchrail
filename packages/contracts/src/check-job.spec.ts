import { describe, expect, it } from 'vitest';
import {
  CHECK_EXECUTION_QUEUE,
  checkRoundJobId,
  createExecuteCheckRoundJob,
  EXECUTE_CHECK_ROUND_JOB,
  InvalidExecuteCheckRoundJobError,
  parseExecuteCheckRoundJob,
} from './check-job.js';

const roundId = '11111111-1111-4111-8111-111111111111';

describe('execute-check-round contract', () => {
  it('owns the canonical queue and job names', () => {
    expect(CHECK_EXECUTION_QUEUE).toBe('check-execution');
    expect(EXECUTE_CHECK_ROUND_JOB).toBe('execute-check-round');
    expect(checkRoundJobId(roundId)).toBe(`check-round-${roundId}`);
  });

  it('creates and parses the version 1 contract', () => {
    const payload = createExecuteCheckRoundJob(roundId);

    expect(parseExecuteCheckRoundJob(payload)).toEqual({
      contractVersion: 1,
      roundId,
    });
  });

  it.each([
    null,
    [],
    {},
    { contractVersion: 2, roundId },
    { contractVersion: 1 },
    { contractVersion: 1, roundId: 'not-a-uuid' },
    { contractVersion: 1, roundId, unexpected: true },
  ])('rejects an invalid payload %#', (payload) => {
    expect(() => parseExecuteCheckRoundJob(payload)).toThrow(InvalidExecuteCheckRoundJobError);
  });

  it('rejects an invalid round ID before deriving a job ID', () => {
    expect(() => checkRoundJobId('not-a-uuid')).toThrow(InvalidExecuteCheckRoundJobError);
  });
});
