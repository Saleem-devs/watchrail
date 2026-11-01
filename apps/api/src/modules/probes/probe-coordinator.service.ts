import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
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
  LEGACY_HTTP_ENGINE_VERSION,
  parseHttpRedirectHops,
  parseHttpStatusPolicy,
  parseStoredAssertionEvaluation,
  parseTlsCertificatePolicy,
  parseTlsCertificateEvidenceList,
} from '@watchrail/domain';
import { resolveRequestHeaders } from '@watchrail/http-header-security';
import { resolveResponseAssertions } from '@watchrail/assertion-security';
import {
  ProbeCoordinatorRepository,
  type AuthoritativeCheckResult,
  type ProbeMachineIdentity,
} from '@watchrail/db';
import { APP_CONFIG, type AppConfig } from '../../config/config.js';

@Injectable()
export class ProbeCoordinatorService {
  private readonly logger = new Logger(ProbeCoordinatorService.name);

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
    if (stored.type === 'DNS') {
      if (stored.dnsName === null || stored.dnsRecordType === null) {
        throw new Error('Stored DNS execution configuration is incomplete.');
      }
      return parseProbeExecutionConfiguration({
        contractVersion: 1,
        type: 'DNS',
        assignmentId: stored.assignmentId,
        attemptId: stored.attemptId,
        configurationVersionId: stored.configurationVersionId,
        configurationVersionNumber: stored.configurationVersionNumber,
        executionPolicyVersion: stored.executionPolicyVersion,
        requiredEngineVersion: stored.requiredEngineVersion,
        name: stored.dnsName,
        recordType: stored.dnsRecordType,
        expectedValues: stored.dnsExpectedValues,
        timeoutMs: stored.timeoutMs,
      });
    }
    if (stored.type === 'TCP') {
      if (stored.tcpHost === null || stored.tcpPort === null) {
        throw new Error('Stored TCP execution configuration is incomplete.');
      }
      return parseProbeExecutionConfiguration({
        contractVersion: 1,
        type: 'TCP',
        assignmentId: stored.assignmentId,
        attemptId: stored.attemptId,
        configurationVersionId: stored.configurationVersionId,
        configurationVersionNumber: stored.configurationVersionNumber,
        executionPolicyVersion: stored.executionPolicyVersion,
        requiredEngineVersion: stored.requiredEngineVersion,
        host: stored.tcpHost,
        port: stored.tcpPort,
        timeoutMs: stored.timeoutMs,
      });
    }
    if (!isHttpMonitorMethod(stored.method)) {
      throw new Error('Stored remote execution method is unsupported.');
    }
    const context = {
      organizationId: stored.organizationId,
      monitorId: stored.monitorId,
    };
    const tlsPolicy = parseTlsCertificatePolicy(stored.tlsPolicy);
    if (
      stored.requiredEngineVersion === LEGACY_HTTP_ENGINE_VERSION &&
      tlsPolicy.type !== 'DISABLED'
    ) {
      throw new Error('A legacy probe assignment cannot execute a TLS certificate policy.');
    }
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
      tlsPolicy,
      requestHeaders: resolveRequestHeaders(
        stored.requestHeaders,
        context,
        this.config.headerEncryptionKeyring,
      ),
      requestBody: stored.requestBody,
      assertions: resolveResponseAssertions(
        stored.assertions,
        stored.method,
        context,
        this.config.assertionEncryptionKeyring,
      ),
    });
    if (stored.requiredEngineVersion !== LEGACY_HTTP_ENGINE_VERSION) return resolved;
    if ('type' in resolved) throw new Error('Legacy HTTP assignment resolved as TCP.');
    const legacyConfiguration = { ...resolved };
    delete legacyConfiguration.tlsPolicy;
    return legacyConfiguration;
  }

  async claim(machine: ProbeMachineIdentity, body: unknown) {
    const input = parseOrBadRequest(() => parseProbeClaimRequest(body));
    return this.authorized(() =>
      this.coordinator.claim(
        machine,
        input.engineVersion,
        this.config.probePendingAssignmentTimeoutMs,
      ),
    );
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
    if (accepted.state === 'REJECTED') {
      this.logger.warn({
        event: 'probe_result_submission_rejected',
        organizationId: machine.organizationId,
        locationId: machine.locationId,
        agentId: machine.agentId,
        assignmentId: reference.assignmentId,
        attemptId: reference.attemptId,
        reason: accepted.reason,
      });
      throw staleLease();
    }
    return accepted;
  }

  async heartbeat(machine: ProbeMachineIdentity, body: unknown) {
    const input = parseOrBadRequest(() => parseProbeHeartbeat(body));
    return this.authorized(() =>
      this.coordinator.heartbeat(machine, input.engineVersion, input.heartbeatIntervalMs),
    );
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

function isHttpMonitorMethod(
  method: string,
): method is 'GET' | 'HEAD' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'OPTIONS' {
  return (
    method === 'GET' ||
    method === 'HEAD' ||
    method === 'POST' ||
    method === 'PUT' ||
    method === 'PATCH' ||
    method === 'DELETE' ||
    method === 'OPTIONS'
  );
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
  const dnsResultKeys = [
    'answers',
    'attemptDurationMs',
    'checkedAt',
    'outcome',
    'queryTimeMs',
    'reason',
    'stage',
  ];
  if (hasExactKeys(value, dnsResultKeys)) return parseDnsResult(value);
  const tcpResultKeys = [
    'attemptDurationMs',
    'checkedAt',
    'connectionTimeMs',
    'outcome',
    'reason',
    'stage',
  ];
  if (hasExactKeys(value, tcpResultKeys)) return parseTcpResult(value);
  const resultKeys = [
    'assertionEvaluation',
    'attemptDurationMs',
    'checkedAt',
    'outcome',
    'reason',
    'redirects',
    'responseTimeMs',
    'stage',
    'statusCode',
  ];
  if (
    (!hasExactKeys(value, resultKeys) &&
      !hasExactKeys(value, [...resultKeys, 'tlsCertificates'])) ||
    !['PASS', 'FAIL', 'UNKNOWN'].includes(String(value.outcome)) ||
    !['DNS', 'CONNECT', 'TLS', 'HTTP', 'PROBE'].includes(String(value.stage)) ||
    ![
      'COMPLETED',
      'CONNECTED',
      'UNEXPECTED_STATUS',
      'REQUEST_TIMEOUT',
      'NAME_NOT_FOUND',
      'CONNECTION_REFUSED',
      'HOST_UNREACHABLE',
      'CONNECTION_TIMEOUT',
      'CERTIFICATE_EXPIRED',
      'CERTIFICATE_NOT_YET_VALID',
      'CERTIFICATE_HOSTNAME_MISMATCH',
      'CERTIFICATE_UNTRUSTED',
      'CERTIFICATE_EXPIRING',
      'CERTIFICATE_EVIDENCE_UNAVAILABLE',
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
    !hasValidTimingEvidence(value.reason, value.statusCode, value.responseTimeMs) ||
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
    tlsCertificates: parseOrBadRequest(() =>
      parseTlsCertificateEvidenceList(
        Object.hasOwn(value, 'tlsCertificates') ? value.tlsCertificates : [],
      ),
    ),
    checkedAt: new Date(value.checkedAt),
  };
}

function parseDnsResult(value: Record<string, unknown>): AuthoritativeCheckResult {
  const reason = String(value.reason);
  if (
    ![
      'RECORDS_MATCHED',
      'NO_RECORDS',
      'RECORD_MISMATCH',
      'NAME_NOT_FOUND',
      'DNS_TIMEOUT',
      'INTERNAL_ERROR',
    ].includes(reason) ||
    !['PASS', 'FAIL', 'UNKNOWN'].includes(String(value.outcome)) ||
    !['DNS', 'PROBE'].includes(String(value.stage)) ||
    !isNullableNonNegativeNumber(value.queryTimeMs) ||
    !isNonNegativeNumber(value.attemptDurationMs) ||
    !isDnsAnswers(value.answers) ||
    !isCanonicalTimestamp(value.checkedAt)
  ) {
    badRequest();
  }
  const expected = expectedClassification(reason);
  if (value.outcome !== expected.outcome || value.stage !== expected.stage) badRequest();
  const hasCompletedQuery = ['RECORDS_MATCHED', 'NO_RECORDS', 'RECORD_MISMATCH'].includes(reason);
  if (hasCompletedQuery !== (value.queryTimeMs !== null)) badRequest();
  if (reason === 'RECORDS_MATCHED' && value.answers.length === 0) badRequest();
  return {
    outcome: value.outcome as AuthoritativeCheckResult['outcome'],
    stage: value.stage as AuthoritativeCheckResult['stage'],
    reason: value.reason as AuthoritativeCheckResult['reason'],
    statusCode: null,
    responseTimeMs: value.queryTimeMs,
    attemptDurationMs: value.attemptDurationMs,
    redirects: [],
    assertionEvaluation: { contractVersion: 1, outcome: 'PASS', diagnostics: [] },
    tlsCertificates: [],
    dnsAnswers: value.answers,
    checkedAt: new Date(value.checkedAt),
  };
}

function parseTcpResult(value: Record<string, unknown>): AuthoritativeCheckResult {
  const reason = String(value.reason);
  if (
    ![
      'CONNECTED',
      'NAME_NOT_FOUND',
      'CONNECTION_REFUSED',
      'HOST_UNREACHABLE',
      'CONNECTION_TIMEOUT',
      'PROHIBITED_DESTINATION',
      'INTERNAL_ERROR',
    ].includes(reason) ||
    !['PASS', 'FAIL', 'UNKNOWN'].includes(String(value.outcome)) ||
    !['DNS', 'CONNECT', 'PROBE'].includes(String(value.stage)) ||
    !isNullableNonNegativeNumber(value.connectionTimeMs) ||
    !isNonNegativeNumber(value.attemptDurationMs) ||
    !isCanonicalTimestamp(value.checkedAt)
  ) {
    badRequest();
  }
  const expected = expectedClassification(reason);
  if (value.outcome !== expected.outcome || value.stage !== expected.stage) badRequest();
  if ((reason === 'CONNECTED') !== (value.connectionTimeMs !== null)) badRequest();
  return {
    outcome: value.outcome as AuthoritativeCheckResult['outcome'],
    stage: value.stage as AuthoritativeCheckResult['stage'],
    reason: value.reason as AuthoritativeCheckResult['reason'],
    statusCode: null,
    responseTimeMs: value.connectionTimeMs,
    attemptDurationMs: value.attemptDurationMs,
    redirects: [],
    assertionEvaluation: { contractVersion: 1, outcome: 'PASS', diagnostics: [] },
    tlsCertificates: [],
    checkedAt: new Date(value.checkedAt),
  };
}

function expectedClassification(reason: string): { outcome: string; stage: string } {
  if (reason === 'COMPLETED') return { outcome: 'PASS', stage: 'HTTP' };
  if (reason === 'CONNECTED') return { outcome: 'PASS', stage: 'CONNECT' };
  if (reason === 'RECORDS_MATCHED') return { outcome: 'PASS', stage: 'DNS' };
  if (['NO_RECORDS', 'RECORD_MISMATCH', 'DNS_TIMEOUT'].includes(reason)) {
    return { outcome: 'FAIL', stage: 'DNS' };
  }
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
  if (
    reason === 'CONNECTION_REFUSED' ||
    reason === 'HOST_UNREACHABLE' ||
    reason === 'CONNECTION_TIMEOUT'
  ) {
    return { outcome: 'FAIL', stage: 'CONNECT' };
  }
  if (
    [
      'CERTIFICATE_EXPIRED',
      'CERTIFICATE_NOT_YET_VALID',
      'CERTIFICATE_HOSTNAME_MISMATCH',
      'CERTIFICATE_UNTRUSTED',
      'CERTIFICATE_EXPIRING',
      'TLS_HANDSHAKE_FAILED',
    ].includes(reason)
  ) {
    return { outcome: 'FAIL', stage: 'TLS' };
  }
  if (reason === 'CERTIFICATE_EVIDENCE_UNAVAILABLE') {
    return { outcome: 'UNKNOWN', stage: 'TLS' };
  }
  return { outcome: 'UNKNOWN', stage: 'PROBE' };
}

function hasValidTimingEvidence(
  reason: unknown,
  statusCode: unknown,
  responseTimeMs: unknown,
): boolean {
  if (reason === 'CONNECTED') return statusCode === null && isNonNegativeNumber(responseTimeMs);
  if (
    reason === 'CONNECTION_REFUSED' ||
    reason === 'HOST_UNREACHABLE' ||
    reason === 'CONNECTION_TIMEOUT'
  ) {
    return statusCode === null && responseTimeMs === null;
  }
  return (statusCode === null) === (responseTimeMs === null);
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

function isDnsAnswers(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= 32 &&
    value.every((item) => typeof item === 'string' && item.length > 0 && item.length <= 512)
  );
}
