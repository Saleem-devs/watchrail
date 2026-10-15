import { createHash, randomBytes } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import {
  ProbeAuthenticationError,
  ProbeEnrollmentUnavailableError,
  ProbeIdentityNotFoundError,
  ProbeIdentityRepository,
  ProbeLocationUnavailableError,
  type ProbeMachineIdentity,
} from '@watchrail/db';
import type { RequestContext } from './request-context.js';

const ENROLLMENT_TTL_SECONDS = 15 * 60;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/u;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u;

@Injectable()
export class ProbeIdentityService {
  constructor(
    @Inject(ProbeIdentityRepository)
    private readonly probes: ProbeIdentityRepository,
  ) {}

  createLocation(context: RequestContext, value: unknown) {
    const input = parseLocation(value);
    return this.probes.createLocation(context.organizationId, input).catch((error: unknown) => {
      if (isUniqueViolation(error)) throw new ConflictException(safeError('PROBE_LOCATION_TAKEN'));
      throw error;
    });
  }

  listLocations(context: RequestContext) {
    return this.probes.listLocationHealth(context.organizationId);
  }

  setLocationStatus(context: RequestContext, locationId: string, value: unknown) {
    const status = parseLocationStatus(value);
    return this.probes
      .setLocationStatus(context.organizationId, locationId, status)
      .catch((error: unknown) => this.translateOperator(error));
  }

  async issueEnrollment(context: RequestContext, locationId: string, value: unknown) {
    const agentName = parseAgentName(value);
    const token = secret();
    try {
      const enrollment = await this.probes.issueEnrollment(
        context.organizationId,
        locationId,
        agentName,
        verifier(token),
        ENROLLMENT_TTL_SECONDS,
      );
      return { enrollment, token };
    } catch (error) {
      this.translateOperator(error);
    }
  }

  async revokeEnrollment(context: RequestContext, enrollmentId: string): Promise<void> {
    try {
      await this.probes.revokeEnrollment(context.organizationId, enrollmentId);
    } catch (error) {
      this.translateOperator(error);
    }
  }

  listAgents(context: RequestContext) {
    return this.probes.listAgentHealth(context.organizationId);
  }

  async revokeAgent(context: RequestContext, agentId: string): Promise<void> {
    try {
      await this.probes.revokeAgent(context.organizationId, agentId);
    } catch (error) {
      this.translateOperator(error);
    }
  }

  async enroll(value: unknown) {
    const input = parseEnrollment(value);
    const credential = secret();
    try {
      const identity = await this.probes.enroll(
        input.enrollmentId,
        verifier(input.token),
        verifier(credential),
      );
      return { identity, credential };
    } catch (error) {
      if (error instanceof ProbeEnrollmentUnavailableError) this.unauthorized();
      throw error;
    }
  }

  async authenticate(rawCredential: string): Promise<ProbeMachineIdentity> {
    if (!TOKEN_PATTERN.test(rawCredential)) this.unauthorized();
    try {
      return await this.probes.authenticate(verifier(rawCredential));
    } catch (error) {
      if (error instanceof ProbeAuthenticationError) this.unauthorized();
      throw error;
    }
  }

  async rotate(machine: ProbeMachineIdentity) {
    const credential = secret();
    try {
      const identity = await this.probes.rotateCredential(machine, verifier(credential));
      return { identity, credential };
    } catch (error) {
      if (error instanceof ProbeAuthenticationError || isUniqueViolation(error)) {
        this.unauthorized();
      }
      throw error;
    }
  }

  private translateOperator(error: unknown): never {
    if (error instanceof ProbeIdentityNotFoundError) {
      throw new NotFoundException(safeError('PROBE_RESOURCE_NOT_FOUND'));
    }
    if (error instanceof ProbeLocationUnavailableError) {
      throw new ConflictException(safeError('PROBE_LOCATION_DISABLED'));
    }
    throw error;
  }

  private unauthorized(): never {
    throw new UnauthorizedException({
      code: 'PROBE_AUTHENTICATION_FAILED',
      message: 'Probe authentication failed.',
    });
  }
}

function secret(): string {
  return randomBytes(32).toString('base64url');
}

function verifier(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('base64url');
}

function parseLocation(value: unknown): { name: string; slug: string } {
  if (!hasExactKeys(value, ['name', 'slug'])) invalid();
  const name = parseName(value.name);
  if (typeof value.slug !== 'string' || !SLUG_PATTERN.test(value.slug) || value.slug === 'local') {
    invalid();
  }
  return { name, slug: value.slug };
}

function parseLocationStatus(value: unknown): 'ACTIVE' | 'DISABLED' {
  if (
    !hasExactKeys(value, ['status']) ||
    (value.status !== 'ACTIVE' && value.status !== 'DISABLED')
  ) {
    invalid();
  }
  return value.status;
}

function parseAgentName(value: unknown): string {
  if (!hasExactKeys(value, ['agentName'])) invalid();
  return parseName(value.agentName);
}

function parseEnrollment(value: unknown): { enrollmentId: string; token: string } {
  if (
    !hasExactKeys(value, ['enrollmentId', 'token']) ||
    typeof value.enrollmentId !== 'string' ||
    !UUID_PATTERN.test(value.enrollmentId) ||
    typeof value.token !== 'string' ||
    !TOKEN_PATTERN.test(value.token)
  ) {
    invalid();
  }
  return { enrollmentId: value.enrollmentId, token: value.token };
}

function parseName(value: unknown): string {
  if (typeof value !== 'string') invalid();
  const normalized = value.trim();
  if (normalized.length < 1 || normalized.length > 120) invalid();
  return normalized;
}

function hasExactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function invalid(): never {
  throw new BadRequestException({ code: 'VALIDATION_FAILED', message: 'Request is invalid.' });
}

function safeError(code: string) {
  return { code, message: 'Probe identity operation could not be completed.' };
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === '23505';
}
