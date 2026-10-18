import { createHash, randomBytes } from 'node:crypto';
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AuthApiKeyRepository, AuthMembershipRepository } from '@watchrail/db';
import type { RequestContext } from './request-context.js';
import { hasPermission, PERMISSIONS, type Permission } from './permissions.js';

const ALL_PERMISSIONS = new Set<string>(Object.values(PERMISSIONS));

@Injectable()
export class ApiCredentialsService {
  constructor(
    private readonly credentials: AuthApiKeyRepository,
    private readonly memberships: AuthMembershipRepository,
  ) {}

  async create(context: RequestContext, input: unknown) {
    requireHumanSession(context);
    const candidate = parseCreateInput(input);
    const role = await this.memberships.roleForUser(context.actorId, context.organizationId);
    if (!role) throw new ForbiddenException('Organization membership is required.');
    for (const permission of candidate.permissions) {
      if (!hasPermission(role, permission)) {
        throw new ForbiddenException('An API credential cannot exceed the creator permissions.');
      }
    }

    const secret = randomBytes(32).toString('base64url');
    const token = `wrk_${secret}`;
    const record = await this.credentials.create({
      name: candidate.name,
      keyHash: hashApiKey(token),
      start: token.slice(0, 12),
      prefix: 'wrk_',
      userId: context.actorId,
      organizationId: context.organizationId,
      permissions: JSON.stringify(candidate.permissions),
      expiresAt: candidate.expiresAt,
    });
    return { record, token };
  }

  list(context: RequestContext) {
    return this.credentials.list(context.organizationId);
  }

  async revoke(context: RequestContext, id: string): Promise<void> {
    requireHumanSession(context);
    if (!(await this.credentials.revoke(context.organizationId, id))) {
      throw new NotFoundException('API credential not found.');
    }
  }
}

function requireHumanSession(context: RequestContext): void {
  if (context.authenticationType === 'API_KEY') {
    throw new ForbiddenException('API credentials cannot manage API credentials.');
  }
}

export function hashApiKey(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function parseApiKeyPermissions(value: string | null): Permission[] | null {
  if (!value) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    if (
      !Array.isArray(parsed) ||
      parsed.length === 0 ||
      parsed.some(
        (permission) => typeof permission !== 'string' || !ALL_PERMISSIONS.has(permission),
      )
    ) {
      return null;
    }
    return [...new Set(parsed)] as Permission[];
  } catch {
    return null;
  }
}

function parseCreateInput(value: unknown): {
  name: string;
  permissions: Permission[];
  expiresAt: Date | null;
} {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new BadRequestException('Invalid API credential input.');
  }
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some((key) => !['name', 'permissions', 'expiresAt'].includes(key))) {
    throw new BadRequestException('Invalid API credential input.');
  }
  if (
    typeof input['name'] !== 'string' ||
    input['name'].trim().length < 1 ||
    input['name'].length > 120
  ) {
    throw new BadRequestException('API credential name must contain 1 to 120 characters.');
  }
  if (
    !Array.isArray(input['permissions']) ||
    input['permissions'].length < 1 ||
    input['permissions'].length > ALL_PERMISSIONS.size ||
    input['permissions'].some(
      (permission) => typeof permission !== 'string' || !ALL_PERMISSIONS.has(permission),
    )
  ) {
    throw new BadRequestException('API credential permissions are invalid.');
  }
  let expiresAt: Date | null = null;
  if (input['expiresAt'] !== undefined && input['expiresAt'] !== null) {
    if (typeof input['expiresAt'] !== 'string') {
      throw new BadRequestException('API credential expiry must be an ISO timestamp.');
    }
    expiresAt = new Date(input['expiresAt']);
    if (Number.isNaN(expiresAt.getTime()) || expiresAt <= new Date()) {
      throw new BadRequestException('API credential expiry must be in the future.');
    }
  }
  return {
    name: input['name'].trim(),
    permissions: [...new Set(input['permissions'])] as Permission[],
    expiresAt,
  };
}
