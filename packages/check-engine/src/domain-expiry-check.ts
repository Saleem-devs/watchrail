import { DOMAIN_EXPIRY_TIMEOUT_LIMITS, DOMAIN_EXPIRY_WARNING_LIMITS } from '@watchrail/domain';
import type {
  DomainExpiryCheckDependencies,
  DomainExpiryCheckInput,
  DomainExpiryCheckResult,
  DomainExpiryEvidenceV1,
} from './domain-expiry-types.js';
import { RdapUnsupportedTldError } from './domain-expiry-types.js';
import type { CheckClock } from './types.js';

const DAY_MS = 86_400_000;
const defaultClock: CheckClock = {
  now: () => new Date(),
  monotonicNow: () => performance.now(),
};

export async function executeDomainExpiryCheck(
  input: DomainExpiryCheckInput,
  dependencies: DomainExpiryCheckDependencies,
): Promise<DomainExpiryCheckResult> {
  assertInput(input);
  const clock = dependencies.clock ?? defaultClock;
  const checkedAt = clock.now();
  const startedAt = clock.monotonicNow();
  const lookupStartedAt = clock.monotonicNow();
  const controller = new AbortController();
  const cancel = () => controller.abort(dependencies.signal?.reason);
  if (dependencies.signal?.aborted) cancel();
  else dependencies.signal?.addEventListener('abort', cancel, { once: true });
  let timeout: ReturnType<typeof setTimeout>;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      controller.abort();
      reject(new Error('RDAP lookup timed out.'));
    }, input.timeoutMs);
  });
  const emptyEvidence = (): DomainExpiryEvidenceV1 => ({
    contractVersion: 1,
    domainName: input.domainName,
    expirationDate: null,
    daysRemaining: null,
    warningDays: input.warningDays,
  });

  try {
    const record = await Promise.race([
      dependencies.client.lookup(input.domainName, controller.signal),
      timeoutPromise,
    ]);
    const lookupTimeMs = elapsed(clock, lookupStartedAt);
    if (record.expirationDate === null || Number.isNaN(record.expirationDate.getTime())) {
      return {
        outcome: 'UNKNOWN',
        stage: 'DOMAIN',
        reason: 'DOMAIN_EXPIRATION_UNAVAILABLE',
        attemptDurationMs: elapsed(clock, startedAt),
        lookupTimeMs,
        checkedAt,
        evidence: emptyEvidence(),
      };
    }
    const daysRemaining = Math.ceil(
      (record.expirationDate.getTime() - checkedAt.getTime()) / DAY_MS,
    );
    const evidence: DomainExpiryEvidenceV1 = {
      contractVersion: 1,
      domainName: input.domainName,
      expirationDate: record.expirationDate.toISOString(),
      daysRemaining,
      warningDays: input.warningDays,
    };
    return {
      outcome: daysRemaining <= input.warningDays ? 'FAIL' : 'PASS',
      stage: 'DOMAIN',
      reason:
        daysRemaining <= 0
          ? 'DOMAIN_EXPIRED'
          : daysRemaining <= input.warningDays
            ? 'DOMAIN_EXPIRING'
            : 'DOMAIN_HEALTHY',
      attemptDurationMs: elapsed(clock, startedAt),
      lookupTimeMs,
      checkedAt,
      evidence,
    } as DomainExpiryCheckResult;
  } catch (error) {
    return {
      outcome: 'UNKNOWN',
      stage: 'DOMAIN',
      reason:
        error instanceof RdapUnsupportedTldError ? 'RDAP_UNSUPPORTED_TLD' : 'RDAP_UNAVAILABLE',
      attemptDurationMs: elapsed(clock, startedAt),
      lookupTimeMs: null,
      checkedAt,
      evidence: emptyEvidence(),
    };
  } finally {
    clearTimeout(timeout!);
    dependencies.signal?.removeEventListener('abort', cancel);
  }
}

function assertInput(input: DomainExpiryCheckInput): void {
  if (input.domainName.trim() === '' || !input.domainName.includes('.')) {
    throw new TypeError('A registered domain name is required.');
  }
  if (
    !Number.isInteger(input.warningDays) ||
    input.warningDays < DOMAIN_EXPIRY_WARNING_LIMITS.minimumDays ||
    input.warningDays > DOMAIN_EXPIRY_WARNING_LIMITS.maximumDays
  ) {
    throw new RangeError('Domain expiry warning threshold is invalid.');
  }
  if (
    !Number.isInteger(input.timeoutMs) ||
    input.timeoutMs < DOMAIN_EXPIRY_TIMEOUT_LIMITS.minimumMs ||
    input.timeoutMs > DOMAIN_EXPIRY_TIMEOUT_LIMITS.maximumMs
  ) {
    throw new RangeError('Domain expiry timeout is invalid.');
  }
}

function elapsed(clock: CheckClock, startedAt: number): number {
  return Math.max(0, Math.round(clock.monotonicNow() - startedAt));
}
