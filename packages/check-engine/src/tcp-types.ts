import type { DnsResolver, ValidatedAddress } from './safe-network-target.js';
import type { CheckClock } from './types.js';

export interface TcpCheckInput {
  host: string;
  port: number;
  timeoutMs: number;
}

interface TcpCheckTiming {
  attemptDurationMs: number;
  checkedAt: Date;
}

export type TcpCheckResult =
  | (TcpCheckTiming & {
      outcome: 'PASS';
      stage: 'CONNECT';
      reason: 'CONNECTED';
      connectionTimeMs: number;
    })
  | (TcpCheckTiming & {
      outcome: 'FAIL';
      stage: 'DNS';
      reason: 'NAME_NOT_FOUND';
      connectionTimeMs: null;
    })
  | (TcpCheckTiming & {
      outcome: 'FAIL';
      stage: 'CONNECT';
      reason: 'CONNECTION_REFUSED' | 'HOST_UNREACHABLE' | 'CONNECTION_TIMEOUT';
      connectionTimeMs: null;
    })
  | (TcpCheckTiming & {
      outcome: 'UNKNOWN';
      stage: 'DNS';
      reason: 'PROHIBITED_DESTINATION';
      connectionTimeMs: null;
    })
  | (TcpCheckTiming & {
      outcome: 'UNKNOWN';
      stage: 'PROBE';
      reason: 'INTERNAL_ERROR';
      connectionTimeMs: null;
    });

export interface TcpConnectInput {
  host: string;
  port: number;
  addresses: readonly ValidatedAddress[];
  signal: AbortSignal;
}

export type TcpConnectResult =
  | { type: 'CONNECTED'; connectionTimeMs: number }
  | { type: 'CONNECTION_REFUSED' }
  | { type: 'HOST_UNREACHABLE' };

export interface TcpConnector {
  connect(input: TcpConnectInput): Promise<TcpConnectResult>;
}

export interface TcpCheckDependencies {
  connector: TcpConnector;
  resolver?: DnsResolver;
  clock?: CheckClock;
  signal?: AbortSignal;
}
