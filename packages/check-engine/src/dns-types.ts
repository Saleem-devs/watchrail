import type { DnsRecordType } from '@watchrail/domain';
import type { CheckClock } from './types.js';

export interface DnsCheckInput {
  name: string;
  recordType: DnsRecordType;
  expectedValues: string[];
  timeoutMs: number;
}

interface DnsCheckTiming {
  attemptDurationMs: number;
  checkedAt: Date;
}

interface DnsCompletedQueryEvidence {
  queryTimeMs: number;
  answers: string[];
}

export type DnsCheckResult =
  | (DnsCheckTiming &
      DnsCompletedQueryEvidence & {
        outcome: 'PASS';
        stage: 'DNS';
        reason: 'RECORDS_MATCHED';
      })
  | (DnsCheckTiming &
      DnsCompletedQueryEvidence & {
        outcome: 'FAIL';
        stage: 'DNS';
        reason: 'NO_RECORDS' | 'RECORD_MISMATCH';
      })
  | (DnsCheckTiming & {
      outcome: 'FAIL';
      stage: 'DNS';
      reason: 'NAME_NOT_FOUND' | 'DNS_TIMEOUT';
      queryTimeMs: null;
      answers: [];
    })
  | (DnsCheckTiming & {
      outcome: 'UNKNOWN';
      stage: 'PROBE';
      reason: 'INTERNAL_ERROR';
      queryTimeMs: null;
      answers: [];
    });

export interface DnsQueryInput {
  name: string;
  recordType: DnsRecordType;
  signal: AbortSignal;
}

export interface DnsQueryResolver {
  resolve(input: DnsQueryInput): Promise<string[]>;
}

export interface DnsCheckDependencies {
  resolver: DnsQueryResolver;
  clock?: CheckClock;
  signal?: AbortSignal;
}
