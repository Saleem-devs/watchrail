import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import {
  parseProbeClaimRequest,
  parseProbeExecutionConfiguration,
  parseProbeHeartbeat,
  parseProbeResultSubmissionReference,
  type ProbeResultSubmissionReferenceV1,
} from '@watchrail/contracts';
import {
  parseHttpRedirectHops,
  parseHttpStatusPolicy,
  parseStoredAssertionEvaluation,
} from '@watchrail/domain';
import { resolveRequestHeaders } from '@watchrail/http-header-security';
import { resolveResponseAssertions } from '@watchrail/assertion-security';
import {
  ProbeCoordinatorRepository,
  type AuthoritativeCheckResult,
  type ProbeMachineIdentity,
} from '@watchrail/db';
import { APP_CONFIG, type AppConfig } from './config.js';

@Injectable()
export class ProbeCoordinatorService {
  constructor(
    @Inject(ProbeCoordinatorRepository) private readonly coordinator: ProbeCoordinatorRepository,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async configuration(
    machine: ProbeMachineIdentity,
    attemptId: string,
    claimToken: string | undefined,
  ) {
    const token = parseClaimToken(claimToken);
    const stored = await this.authorized(() =>
      this.coordinator.configuration(machine, attemptId, token),
    );
    if (!stored) throw staleLease();
    if (stored.method !== 'GET' && stored.method !== 'HEAD') {
      throw new Error('Stored remote execution method is unsupported.');
    }
    const context = {
      organizationId: stored.organizationId,
      monitorId: stored.monitorId,
    };
    const resolved = parseProbeExecutionConfiguration({
      contractVersion: 1,
      assignmentId: stored.assignmentId,
      attemptId: stored.attemptId,
      configurationVersionId: stored.configurationVersionId,
      configurationVersionNumber: stored.configurationVersionNumber,
      executionPolicyVersion: stored.executionPolicyVersion,
      requiredEngineVersion: stored.requiredEngineVersion,
      url: stored.url,
      method: stored.method,
      timeoutMs: stored.timeoutMs,
      followRedirects: stored.followRedirects,
      statusPolicy: parseHttpStatusPolicy(stored.statusPolicy),
      requestHeaders: resolveRequestHeaders(
        stored.requestHeaders,
        context,
        this.config.headerEncryptionKeyring,
      ),
      assertions: resolveResponseAssertions(
        stored.assertions,
        stored.method,
        context,
        this.config.assertionEncryptionKeyring,
      ),
    });
    return resolved;
  }

  async claim(machine: ProbeMachineIdentity, body: unknown) {
    const input = parseOrBadRequest(() => parseProbeClaimRequest(body));
    return this.authorized(() => this.coordinator.claim(machine, input.engineVersion));
  }

  async renew(
    machine: ProbeMachineIdentity,
    attemptId: string,
    claimToken: string | undefined,
    body: unknown,
  ) {
    const input = parseAction(attemptId, body);
    const token = parseClaimToken(claimToken);
    const expiresAt = await this.authorized(() => this.coordinator.renew(machine, input, token));
    if (!expiresAt) throw staleLease();
    return expiresAt;
  }

  async submit(
    machine: ProbeMachineIdentity,
    attemptId: string,
    claimToken: string | undefined,
    body: unknown,
  ) {
    if (!hasExactKeys(body, ['reference', 'result'])) badRequest();
    const reference = parseAction(attemptId, body.reference);
    const token = parseClaimToken(claimToken);
    const result = parseResult(body.result);
    const accepted = await this.authorized(() =>
      this.coordinator.submit(machine, reference, token, result),
    );
    if (accepted.state === 'REJECTED') throw staleLease();
    return accepted;
  }

  async heartbeat(machine: ProbeMachineIdentity, body: unknown) {
    const input = parseOrBadRequest(() => parseProbeHeartbeat(body));
    return this.authorized(() => this.coordinator.heartbeat(machine, input.engineVersion));
  }

  private async authorized<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof Error && error.message === 'PROBE_AUTH') {
        throw new UnauthorizedException({
          code: 'PROBE_AUTHENTICATION_FAILED',
          message: 'Probe authentication failed.',
        });
      }
      throw error;
    }
  }
}

function parseAction(attemptId: string, body: unknown): ProbeResultSubmissionReferenceV1 {
  const parsed = parseOrBadRequest(() => parseProbeResultSubmissionReference(body));
  if (parsed.attemptId !== attemptId) badRequest();
  return parsed;
}

function parseClaimToken(value: string | undefined): string {
  if (!value || !/^[A-Za-z0-9_-]{43}$/u.test(value)) badRequest();
  return value;
}

function parseResult(value: unknown): AuthoritativeCheckResult {
  if (
    !hasExactKeys(value, [
      'assertionEvaluation',
      'attemptDurationMs',
      'checkedAt',
      'outcome',
      'reason',
      'redirects',
      'responseTimeMs',
      'stage',
      'statusCode',
    ]) ||
    !['PASS', 'FAIL', 'UNKNOWN'].includes(String(value.outcome)) ||
    !['DNS', 'CONNECT', 'TLS', 'HTTP', 'PROBE'].includes(String(value.stage)) ||
    ![
      'COMPLETED',
      'UNEXPECTED_STATUS',
      'REQUEST_TIMEOUT',
      'NAME_NOT_FOUND',
      'CONNECTION_REFUSED',
      'CERTIFICATE_EXPIRED',
      'CERTIFICATE_NOT_YET_VALID',
      'CERTIFICATE_HOSTNAME_MISMATCH',
      'CERTIFICATE_UNTRUSTED',
      'TLS_HANDSHAKE_FAILED',
      'PROHIBITED_DESTINATION',
      'REDIRECT_LOOP',
      'TOO_MANY_REDIRECTS',
      'MISSING_REDIRECT_LOCATION',
      'INVALID_REDIRECT_LOCATION',
      'INSECURE_REDIRECT',
      'INTERNAL_ERROR',
    ].includes(String(value.reason)) ||
    !isNullableStatusCode(value.statusCode) ||
    !isNullableNonNegativeNumber(value.responseTimeMs) ||
    !isNonNegativeNumber(value.attemptDurationMs) ||
    (value.statusCode === null) !== (value.responseTimeMs === null) ||
    !isCanonicalTimestamp(value.checkedAt)
  ) {
    badRequest();
  }
  const expected = expectedClassification(String(value.reason));
  if (value.outcome !== expected.outcome || value.stage !== expected.stage) badRequest();
  return {
    outcome: value.outcome as AuthoritativeCheckResult['outcome'],
    stage: value.stage as AuthoritativeCheckResult['stage'],
    reason: value.reason as AuthoritativeCheckResult['reason'],
    statusCode: value.statusCode,
    responseTimeMs: value.responseTimeMs,
    attemptDurationMs: value.attemptDurationMs,
    redirects: parseOrBadRequest(() => parseHttpRedirectHops(value.redirects)),
    assertionEvaluation: parseOrBadRequest(() =>
      parseStoredAssertionEvaluation(value.assertionEvaluation),
    ),
    checkedAt: new Date(value.checkedAt),
  };
}

function expectedClassification(reason: string): { outcome: string; stage: string } {
  if (reason === 'COMPLETED') return { outcome: 'PASS', stage: 'HTTP' };
  if (
    [
      'UNEXPECTED_STATUS',
      'REQUEST_TIMEOUT',
      'REDIRECT_LOOP',
      'TOO_MANY_REDIRECTS',
      'MISSING_REDIRECT_LOCATION',
      'INVALID_REDIRECT_LOCATION',
      'INSECURE_REDIRECT',
    ].includes(reason)
  ) {
    return { outcome: 'FAIL', stage: 'HTTP' };
  }
  if (reason === 'NAME_NOT_FOUND') return { outcome: 'FAIL', stage: 'DNS' };
  if (reason === 'PROHIBITED_DESTINATION') return { outcome: 'UNKNOWN', stage: 'DNS' };
  if (reason === 'CONNECTION_REFUSED') return { outcome: 'FAIL', stage: 'CONNECT' };
  if (
    [
      'CERTIFICATE_EXPIRED',
      'CERTIFICATE_NOT_YET_VALID',
      'CERTIFICATE_HOSTNAME_MISMATCH',
      'CERTIFICATE_UNTRUSTED',
      'TLS_HANDSHAKE_FAILED',
    ].includes(reason)
  ) {
    return { outcome: 'FAIL', stage: 'TLS' };
  }
  return { outcome: 'UNKNOWN', stage: 'PROBE' };
}

function staleLease(): ConflictException {
  return new ConflictException({
    code: 'PROBE_LEASE_NOT_AUTHORITATIVE',
    message: 'Probe lease is no longer authoritative.',
  });
}

function parseOrBadRequest<T>(operation: () => T): T {
  try {
    return operation();
  } catch {
    badRequest();
  }
}

function badRequest(): never {
  throw new BadRequestException({ code: 'INVALID_REQUEST', message: 'Request is invalid.' });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isNullableStatusCode(value: unknown): value is number | null {
  return (
    value === null || (Number.isInteger(value) && Number(value) >= 100 && Number(value) <= 599)
  );
}

function isNullableNonNegativeNumber(value: unknown): value is number | null {
  return value === null || isNonNegativeNumber(value);
}

function isNonNegativeNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isCanonicalTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString() === value;
}
