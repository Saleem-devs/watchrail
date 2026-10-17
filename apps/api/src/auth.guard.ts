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
import { AuthMembershipRepository } from '@watchrail/db';
import type { WatchrailAuth } from './auth.js';
import { WATCHRAIL_AUTH } from './auth.tokens.js';
import { hasPermission, type Permission } from './permissions.js';
import type { RequestWithContext } from './request-context.js';

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
    private readonly memberships: AuthMembershipRepository,
    private readonly reflector: Reflector,
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
    if (request.watchrailContext) {
      // Context was set by DevelopmentIdentityMiddleware.
      // Still check permission if required.
      const requiredPermission = this.reflector.get<Permission | undefined>(
        PERMISSION_KEY,
        context.getHandler(),
      );
      if (
        requiredPermission &&
        !hasPermission('owner', requiredPermission) // dev identity has owner-level access
      ) {
        throw new ForbiddenException(
          `Permission denied: '${requiredPermission}' is required for this operation.`,
        );
      }
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
    const requiredPermission = this.reflector.get<Permission | undefined>(
      PERMISSION_KEY,
      context.getHandler(),
    );

    if (requiredPermission && !hasPermission(role, requiredPermission)) {
      throw new ForbiddenException(
        `Permission denied: '${requiredPermission}' is required for this operation.`,
      );
    }

    // Populate the request context for downstream services.
    request.watchrailContext = {
      actorId: session.user.id,
      organizationId: activeOrganizationId,
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

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
}
