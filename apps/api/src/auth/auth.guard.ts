/**
 * WatchrailAuthGuard — NestJS guard that validates Better Auth sessions.
 *
 * Flow:
 *  1. If the route is marked @Public(), skip all checks.
 *  2. If DEV_IDENTITY_ENABLED is active and watchrailContext is already set
 *     by DevelopmentIdentityMiddleware, skip Better Auth validation (test path).
 *  3. Extract the session token from the request (cookie or Authorization header).
 *  4. Call Better Auth's session API to validate it.
 *  5. Resolve the user's active organization from session.activeOrganizationId.
 *  6. Look up membership + role in the active organization.
 *  7. Check that the role grants the required permission (from @RequirePermission).
 *  8. Attach RequestContext to the request for downstream controllers.
 *
 * Probe machine auth and public status page routes are marked @Public() so
 * the global guard skips them entirely.
 */

import { Injectable, SetMetadata, UnauthorizedException, ForbiddenException } from '@nestjs/common';
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { Inject } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { AuthApiKeyRepository, AuthMembershipRepository } from '@watchrail/db';
import type { WatchrailAuth } from './auth.js';
import { WATCHRAIL_AUTH } from './auth.tokens.js';
import { hasPermission, type Permission } from './permissions.js';
import { DEVELOPMENT_REQUEST_CONTEXT, type RequestWithContext } from './request-context.js';
import { hashApiKey, parseApiKeyPermissions } from '../modules/api-credentials/api-key-auth.js';

// ─── Decorators ───────────────────────────────────────────────────────────────

export const PUBLIC_KEY = 'watchrail:public';
export const PERMISSION_KEY = 'watchrail:permission';

/**
 * Mark a controller or handler as public (no authentication required).
 *
 * Use on controllers that have their own auth mechanism:
 *   - PublicStatusPagesController (unauthenticated)
 *   - InternalStatusPagesController (internal token)
 *   - ProbeMachineController (probe machine credentials)
 */
export const Public = () => SetMetadata(PUBLIC_KEY, true);

/**
 * Attach a required permission to a controller handler.
 * The guard will verify that the authenticated user's role in their active
 * organization grants this permission.
 *
 * @example
 * @Get(':id')
 * @RequirePermission(PERMISSIONS.MONITOR_READ)
 * async getMonitor() { ... }
 */
export const RequirePermission = (permission: Permission) =>
  SetMetadata(PERMISSION_KEY, permission);

// ─── Guard ───────────────────────────────────────────────────────────────────

@Injectable()
export class WatchrailAuthGuard implements CanActivate {
  constructor(
    @Inject(WATCHRAIL_AUTH) private readonly auth: WatchrailAuth,
    @Inject(AuthMembershipRepository)
    private readonly memberships: AuthMembershipRepository,
    @Inject(AuthApiKeyRepository)
    private readonly apiKeys: AuthApiKeyRepository,
    @Inject(Reflector) private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<RequestWithContext>();

    // ─── Public routes ───────────────────────────────────────────────────────
    // Check class-level metadata first, then method-level.
    const isPublic =
      this.reflector.get<boolean>(PUBLIC_KEY, context.getClass()) ||
      this.reflector.get<boolean>(PUBLIC_KEY, context.getHandler());

    if (isPublic) return true;

    // ─── Dev identity bypass ─────────────────────────────────────────────────
    // DevelopmentIdentityMiddleware runs before guards and sets watchrailContext.
    // When it's active (test mode), skip Better Auth validation.
    const requiredPermission = this.reflector.getAllAndOverride<Permission | undefined>(
      PERMISSION_KEY,
      [context.getHandler(), context.getClass()],
    );

    // Protected application routes must declare their authorization policy.
    // This makes newly-added endpoints fail closed instead of silently becoming
    // available to every authenticated organization member.
    if (!requiredPermission) {
      throw new ForbiddenException('This endpoint has no authorization policy.');
    }

    if (request.watchrailContext) {
      // Only the middleware's fixed context is a valid development bypass.
      if (request.watchrailContext !== DEVELOPMENT_REQUEST_CONTEXT) {
        throw new UnauthorizedException('Authentication is required.');
      }
      if (!hasPermission('owner', requiredPermission)) {
        throw new ForbiddenException(
          `Permission denied: '${requiredPermission}' is required for this operation.`,
        );
      }
      return true;
    }

    const apiKey = extractApiKey(request);
    if (apiKey) {
      const identity = await this.apiKeys.authenticate(hashApiKey(apiKey));
      const scopes = identity ? parseApiKeyPermissions(identity.permissions) : null;
      if (!identity || !scopes) {
        throw new UnauthorizedException('Authentication is required.');
      }
      if (
        !scopes.includes(requiredPermission) ||
        !hasPermission(identity.role, requiredPermission)
      ) {
        throw new ForbiddenException(
          `Permission denied: '${requiredPermission}' is required for this operation.`,
        );
      }
      request.watchrailContext = {
        actorId: identity.userId,
        organizationId: identity.organizationId,
        authenticationType: 'API_KEY',
      };
      return true;
    }

    // ─── Better Auth session validation ──────────────────────────────────────

    const session = await this.auth.api
      .getSession({ headers: buildHeaders(request) })
      .catch(() => null);

    if (!session?.user || !session.session) {
      throw new UnauthorizedException('Authentication is required.');
    }

    // Determine the active organization.
    const activeOrganizationId =
      (session.session as { activeOrganizationId?: string | null }).activeOrganizationId ?? null;

    if (!activeOrganizationId) {
      throw new UnauthorizedException(
        'No active organization. Please select an organization first.',
      );
    }

    if (!isUuid(activeOrganizationId)) {
      throw new UnauthorizedException('The active organization is invalid.');
    }

    // Resolve the user's role in the active organization.
    const role = await this.resolveMemberRole(session.user.id, activeOrganizationId);

    if (!role) {
      throw new ForbiddenException('You are not a member of this organization.');
    }

    // Check the required permission.
    if (!hasPermission(role, requiredPermission)) {
      throw new ForbiddenException(
        `Permission denied: '${requiredPermission}' is required for this operation.`,
      );
    }

    // Populate the request context for downstream services.
    request.watchrailContext = {
      actorId: session.user.id,
      organizationId: activeOrganizationId,
      authenticationType: 'SESSION',
    };

    return true;
  }

  private async resolveMemberRole(userId: string, organizationId: string): Promise<string | null> {
    return this.memberships.roleForUser(userId, organizationId);
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function buildHeaders(request: Request): Headers {
  const headers = new Headers();

  const cookieHeader = request.headers.cookie;
  if (cookieHeader) headers.set('cookie', cookieHeader);

  const authHeader = request.headers.authorization;
  if (authHeader) headers.set('authorization', authHeader);

  return headers;
}

function extractApiKey(request: Request): string | null {
  const authorization = request.headers.authorization;
  if (!authorization?.startsWith('Bearer wrk_')) return null;
  const token = authorization.slice('Bearer '.length);
  return /^wrk_[A-Za-z0-9_-]{43}$/u.test(token) ? token : null;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
}
