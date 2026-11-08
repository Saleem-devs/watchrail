import type { CheckClock } from './types.js';

export interface DomainExpiryCheckInput {
  domainName: string;
  warningDays: number;
  timeoutMs: number;
}

export interface RdapDomainRecord {
  expirationDate: Date | null;
  sourceUrl: string;
}

export interface RdapDomainClient {
  lookup(domainName: string, signal: AbortSignal): Promise<RdapDomainRecord>;
}

export interface DomainExpiryEvidenceV1 {
  contractVersion: 1;
  domainName: string;
  expirationDate: string | null;
  daysRemaining: number | null;
  warningDays: number;
}

interface DomainExpiryTiming {
  attemptDurationMs: number;
  lookupTimeMs: number | null;
  checkedAt: Date;
  evidence: DomainExpiryEvidenceV1;
}

export type DomainExpiryCheckResult = DomainExpiryTiming &
  (
    | { outcome: 'PASS'; stage: 'DOMAIN'; reason: 'DOMAIN_HEALTHY' }
    | {
        outcome: 'FAIL';
        stage: 'DOMAIN';
        reason: 'DOMAIN_EXPIRING' | 'DOMAIN_EXPIRED';
      }
    | {
        outcome: 'UNKNOWN';
        stage: 'DOMAIN';
        reason: 'RDAP_UNAVAILABLE' | 'RDAP_UNSUPPORTED_TLD' | 'DOMAIN_EXPIRATION_UNAVAILABLE';
      }
  );

export interface DomainExpiryCheckDependencies {
  client: RdapDomainClient;
  clock?: CheckClock;
  signal?: AbortSignal;
}

export class RdapUnsupportedTldError extends Error {}
