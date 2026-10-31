import { randomUUID } from 'node:crypto';
import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { executeHttpCheck, NodeHttpExecutor, type HttpCheckInput } from '@watchrail/check-engine';
import { MonitorRepository, ProjectRepository } from '@watchrail/db';
import {
  AssertionInputError,
  EMPTY_ASSERTION_CONFIGURATION,
  MonitorInputError,
  parseHttpConfigurationTest,
  RequestHeaderInputError,
  type ResponseAssertions,
} from '@watchrail/domain';
import {
  AssertionRetentionError,
  resolveResponseAssertions,
  storeResponseAssertions,
} from '@watchrail/assertion-security';
import { resolveRequestHeaders, storeRequestHeaders } from '@watchrail/http-header-security';
import type { RequestContext } from '../../auth/request-context.js';
import { PublicStatusPageRateLimiter } from '../../common/rate-limiting/public-status-page-rate-limiter.js';
import { APP_CONFIG, type AppConfig } from '../../config/config.js';
import {
  toSafeTransientCheckResult,
  type SafeTransientCheckResult,
} from './transient-response-evidence.js';

export class MonitorConfigurationTestRateLimiter extends PublicStatusPageRateLimiter {
  constructor() {
    super({
      clientCapacity: 10,
      clientRefillPerSecond: 1 / 6,
      globalCapacity: 120,
      globalRefillPerSecond: 2,
      clientTtlMs: 10 * 60 * 1_000,
      sweepIntervalMs: 60 * 1_000,
      maximumTrackedClients: 10_000,
      maximumRetryAfterSeconds: 60,
    });
  }
}

@Injectable()
export class MonitorConfigurationTestService {
  constructor(
    @Inject(MonitorRepository) private readonly monitors: MonitorRepository,
    @Inject(ProjectRepository) private readonly projects: ProjectRepository,
    @Inject(NodeHttpExecutor) private readonly executor: NodeHttpExecutor,
    @Inject(MonitorConfigurationTestRateLimiter)
    private readonly limiter: MonitorConfigurationTestRateLimiter,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async execute(
    context: RequestContext,
    projectId: string,
    value: unknown,
    monitorId?: string,
  ): Promise<SafeTransientCheckResult> {
    try {
      const limit = this.limiter.consume(`${context.organizationId}:${context.actorId}`);
      if (!limit.allowed) {
        throw new HttpException(
          {
            code: 'CONFIGURATION_TEST_RATE_LIMITED',
            message: `Too many configuration tests. Try again in ${limit.retryAfterSeconds} seconds.`,
          },
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
      const existing = monitorId
        ? await this.monitors.findForProject(context.organizationId, projectId, monitorId)
        : null;
      if (monitorId && !existing) throw new NotFoundException(monitorNotFound());
      if (!monitorId) await this.assertProject(context, projectId);

      const input = parseHttpConfigurationTest(value);
      const encryptionMonitorId = existing?.id ?? randomUUID();
      const encryptionContext = {
        organizationId: context.organizationId,
        monitorId: encryptionMonitorId,
      };
      const storedHeaders = storeRequestHeaders(
        input.requestHeaders,
        existing?.requestHeaders ?? [],
        encryptionContext,
        this.config.headerEncryptionKeyring,
      );
      const requestHeaders = resolveRequestHeaders(
        storedHeaders,
        encryptionContext,
        this.config.headerEncryptionKeyring,
      );
      const storedAssertions = storeResponseAssertions(
        input.assertions,
        existing?.assertions ?? EMPTY_ASSERTION_CONFIGURATION,
        input.settings.method,
        encryptionContext,
        this.config.assertionEncryptionKeyring,
        { allowRetain: Boolean(existing) },
      );
      const assertions = resolveResponseAssertions(
        storedAssertions,
        input.settings.method,
        encryptionContext,
        this.config.assertionEncryptionKeyring,
      );
      const checkInput: HttpCheckInput = {
        ...input.settings,
        statusPolicy: input.statusPolicy,
        requestHeaders,
        headerAssertions: assertions.headers,
        textBodyAssertions: assertions.textBody,
        jsonBodyAssertions: assertions.jsonBody,
        captureResponseEvidence: true,
      };
      const result = await executeHttpCheck(checkInput, { executor: this.executor });
      return toSafeTransientCheckResult(
        result,
        input.statusPolicy,
        input.settings.method,
        secretValues(
          input.settings.url,
          input.settings.requestBody,
          input.requestHeaders,
          requestHeaders,
          assertions,
        ),
      );
    } catch (error) {
      this.throwExpectedError(error);
    }
  }

  private async assertProject(context: RequestContext, projectId: string): Promise<void> {
    const project = await this.projects.findForOrganization(context.organizationId, projectId);
    if (!project)
      throw new NotFoundException({ code: 'PROJECT_NOT_FOUND', message: 'Project not found.' });
  }

  private throwExpectedError(error: unknown): never {
    if (error instanceof MonitorInputError) {
      throw new BadRequestException({
        code: 'VALIDATION_FAILED',
        message: error.message,
        fields: error.fields,
      });
    }
    if (error instanceof RequestHeaderInputError) {
      throw new BadRequestException({
        code: 'VALIDATION_FAILED',
        message: error.message,
        fields: { requestHeaders: error.issues },
      });
    }
    if (error instanceof AssertionInputError || error instanceof AssertionRetentionError) {
      throw new BadRequestException({
        code: 'VALIDATION_FAILED',
        message: 'Response assertions are invalid.',
        fields: {
          assertions: error instanceof AssertionInputError ? error.issues : [error.message],
        },
      });
    }
    if (error instanceof Error && error.message.startsWith('Cannot retain missing sensitive')) {
      throw new BadRequestException({
        code: 'VALIDATION_FAILED',
        message: 'Request headers are invalid.',
        fields: { requestHeaders: [error.message] },
      });
    }
    throw error;
  }
}

function secretValues(
  url: string,
  requestBody: HttpCheckInput['requestBody'],
  updates: readonly { name: string; sensitive: boolean }[],
  resolvedHeaders: readonly { name: string; value: string }[],
  assertions: ResponseAssertions,
): string[] {
  const sensitiveHeaderNames = new Set(
    updates.filter((header) => header.sensitive).map((header) => header.name),
  );
  const values = resolvedHeaders
    .filter((header) => sensitiveHeaderNames.has(header.name))
    .map((header) => header.value);
  const parsedUrl = new URL(url);
  for (const [name, value] of parsedUrl.searchParams) {
    if (sensitiveFieldName.test(name)) values.push(value);
  }
  if (requestBody?.type === 'JSON') {
    try {
      collectSensitiveJsonValues(JSON.parse(requestBody.value) as unknown, values);
    } catch {
      // Domain validation already reports malformed JSON before execution.
    }
  } else if (requestBody?.type === 'FORM_URLENCODED') {
    for (const field of requestBody.fields) {
      if (sensitiveFieldName.test(field.name)) values.push(field.value);
    }
  }
  for (const assertion of [...assertions.headers, ...assertions.textBody, ...assertions.jsonBody]) {
    if ('target' in assertion && assertion.target.sensitive) {
      const value = sensitiveTargetValue(assertion.target.value);
      if (value !== null) values.push(value);
    }
  }
  return values;
}

const sensitiveFieldName =
  /(?:^|[-_])(api[-_]?key|authorization|cookie|credential|password|passwd|private[-_]?key|refresh[-_]?token|secret|session|token)(?:$|[-_])/iu;

function collectSensitiveJsonValues(value: unknown, output: string[]): void {
  if (Array.isArray(value)) {
    for (const item of value) collectSensitiveJsonValues(item, output);
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (sensitiveFieldName.test(key)) {
      const secret = sensitiveTargetValue(child);
      if (secret !== null) output.push(secret);
    } else {
      collectSensitiveJsonValues(child, output);
    }
  }
}

function sensitiveTargetValue(value: unknown): string | null {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return `${value}`;
  }
  if (!value || typeof value !== 'object' || !('value' in value)) return null;
  const scalar = value.value;
  if (scalar === null) return 'null';
  if (typeof scalar === 'string' || typeof scalar === 'number' || typeof scalar === 'boolean') {
    return `${scalar}`;
  }
  return null;
}

function monitorNotFound() {
  return { code: 'MONITOR_NOT_FOUND', message: 'Monitor not found.' };
}
