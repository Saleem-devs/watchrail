import { randomBytes } from 'node:crypto';
import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AuthApiKeyRepository, AuthMembershipRepository } from '@watchrail/db';
import { hasPermission } from '../../auth/permissions.js';
import type { RequestContext } from '../../auth/request-context.js';
import { hashApiKey } from './api-key-auth.js';
import type { CreateApiCredentialInput } from './dto/create-api-credential.input.js';

@Injectable()
export class ApiCredentialsService {
  constructor(
    @Inject(AuthApiKeyRepository) private readonly credentials: AuthApiKeyRepository,
    @Inject(AuthMembershipRepository) private readonly memberships: AuthMembershipRepository,
  ) {}

  async create(context: RequestContext, input: CreateApiCredentialInput) {
    requireHumanSession(context);
    const expiresAt = parseExpiry(input.expiresAt);
    const permissions = [...new Set(input.permissions)];
    const role = await this.memberships.roleForUser(context.actorId, context.organizationId);
    if (!role) throw new ForbiddenException('Organization membership is required.');
    for (const permission of permissions) {
      if (!hasPermission(role, permission)) {
        throw new ForbiddenException('An API credential cannot exceed the creator permissions.');
      }
    }

    const secret = randomBytes(32).toString('base64url');
    const token = `wrk_${secret}`;
    const record = await this.credentials.create({
      name: input.name,
      keyHash: hashApiKey(token),
      start: token.slice(0, 12),
      prefix: 'wrk_',
      userId: context.actorId,
      organizationId: context.organizationId,
      permissions: JSON.stringify(permissions),
      expiresAt,
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

function parseExpiry(value: string | null | undefined): Date | null {
  if (value == null) return null;
  const expiresAt = new Date(value);
  if (Number.isNaN(expiresAt.getTime()) || expiresAt <= new Date()) {
    const message = 'API credential expiry must be in the future.';
    throw new BadRequestException({
      code: 'VALIDATION_FAILED',
      message,
      fields: { expiresAt: [message] },
    });
  }
  return expiresAt;
}
