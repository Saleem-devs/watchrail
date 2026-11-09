import type { DnsResolver, ValidatedAddress } from './safe-network-target.js';
import type { CheckClock } from './types.js';

export interface IcmpCheckInput {
  host: string;
  timeoutMs: number;
}

interface IcmpCheckTiming {
  attemptDurationMs: number;
  checkedAt: Date;
}

export type IcmpCheckResult =
  | (IcmpCheckTiming & {
      outcome: 'PASS';
      stage: 'ICMP';
      reason: 'PING_REPLIED';
      responseTimeMs: number;
    })
  | (IcmpCheckTiming & {
      outcome: 'FAIL';
      stage: 'DNS';
      reason: 'NAME_NOT_FOUND';
      responseTimeMs: null;
    })
  | (IcmpCheckTiming & {
      outcome: 'FAIL';
      stage: 'ICMP';
      reason: 'PING_TIMEOUT' | 'PING_HOST_UNREACHABLE';
      responseTimeMs: null;
    })
  | (IcmpCheckTiming & {
      outcome: 'UNKNOWN';
      stage: 'DNS';
      reason: 'PROHIBITED_DESTINATION';
      responseTimeMs: null;
    })
  | (IcmpCheckTiming & {
      outcome: 'UNKNOWN';
      stage: 'PROBE';
      reason: 'ICMP_UNAVAILABLE' | 'INTERNAL_ERROR';
      responseTimeMs: null;
    });

export interface IcmpPingInput {
  host: string;
  addresses: readonly ValidatedAddress[];
  signal: AbortSignal;
}

export type IcmpPingResult =
  | { type: 'REPLY'; responseTimeMs: number }
  | { type: 'NO_REPLY' }
  | { type: 'HOST_UNREACHABLE' }
  | { type: 'ICMP_UNAVAILABLE' }
  | { type: 'EXECUTION_ERROR' };

export interface IcmpPinger {
  ping(input: IcmpPingInput): Promise<IcmpPingResult>;
}

export interface IcmpCheckDependencies {
  pinger: IcmpPinger;
  resolver?: DnsResolver;
  clock?: CheckClock;
  signal?: AbortSignal;
}
