/**
 * OrganizationsService — thin wrapper around Better Auth's organization plugin
 * server-side API for use by OrganizationsController.
 *
 * This service does not duplicate Better Auth's logic — it delegates to the
 * auth instance's internal API and re-shapes the responses for Watchrail's
 * contract format.
 */

import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
  ForbiddenException,
} from '@nestjs/common';
import { AuthMembershipInvariantError, AuthMembershipRepository } from '@watchrail/db';
import { WATCHRAIL_AUTH } from './auth.tokens.js';
import type { WatchrailAuth } from './auth.js';
import type { RequestContext } from './request-context.js';
import { isOrganizationRole, type OrganizationRole } from './permissions.js';

export interface OrganizationResponse {
  id: string;
  name: string;
  slug: string | null;
  createdAt: string;
}

export interface MemberResponse {
  id: string;
  userId: string;
  role: string;
  createdAt: string;
}

export interface InvitationResponse {
  id: string;
  email: string;
  role: string | null;
  status: string;
  expiresAt: string;
}

@Injectable()
export class OrganizationsService {
  constructor(
    @Inject(WATCHRAIL_AUTH) private readonly auth: WatchrailAuth,
    private readonly memberships: AuthMembershipRepository,
  ) {}

  async listOrganizations(
    ctx: RequestContext,
    requestHeaders: Headers,
  ): Promise<OrganizationResponse[]> {
    const result = await this.auth.api.listOrganizations({ headers: requestHeaders });
    if (!Array.isArray(result)) return [];
    return result.map(formatOrg);
  }

  async getOrganization(
    ctx: RequestContext,
    requestHeaders: Headers,
  ): Promise<OrganizationResponse> {
    const org = await this.auth.api
      .getFullOrganization({
        query: { organizationId: ctx.organizationId },
        headers: requestHeaders,
      })
      .catch(() => null);

    if (!org) throw new NotFoundException('Organization not found.');
    return formatOrg(org);
  }

  async updateOrganization(
    ctx: RequestContext,
    requestHeaders: Headers,
    body: { name?: string; slug?: string },
  ): Promise<OrganizationResponse> {
    const updated = await this.auth.api.updateOrganization({
      body: {
        organizationId: ctx.organizationId,
        data: body,
      },
      headers: requestHeaders,
    });
    if (!updated) throw new NotFoundException('Organization not found.');
    return formatOrg(updated);
  }

  async deleteOrganization(ctx: RequestContext, requestHeaders: Headers): Promise<void> {
    await this.auth.api.deleteOrganization({
      body: { organizationId: ctx.organizationId },
      headers: requestHeaders,
    });
  }

  async listMembers(ctx: RequestContext, requestHeaders: Headers): Promise<MemberResponse[]> {
    const result = await this.auth.api.listMembers({
      query: { organizationId: ctx.organizationId },
      headers: requestHeaders,
    });
    if (!Array.isArray(result)) return [];
    return result.map(formatMember);
  }

  async removeMember(
    ctx: RequestContext,
    requestHeaders: Headers,
    memberId: string,
  ): Promise<void> {
    // Prevent removing self as owner.
    await this.auth.api.removeMember({
      body: {
        organizationId: ctx.organizationId,
        memberIdOrEmail: memberId,
      },
      headers: requestHeaders,
    });
  }

  async updateMemberRole(
    ctx: RequestContext,
    requestHeaders: Headers,
    memberId: string,
    role: string,
  ): Promise<MemberResponse> {
    const validatedRole = requireAssignableRole(role);
    const updated = await this.auth.api.updateMemberRole({
      body: {
        organizationId: ctx.organizationId,
        memberId,
        role: validatedRole,
      },
      headers: requestHeaders,
    });
    if (!updated) throw new NotFoundException('Member not found.');
    return formatMember(updated);
  }

  async listInvitations(
    ctx: RequestContext,
    requestHeaders: Headers,
  ): Promise<InvitationResponse[]> {
    const result = await this.auth.api.listInvitations({
      query: { organizationId: ctx.organizationId },
      headers: requestHeaders,
    });
    if (!Array.isArray(result)) return [];
    return result.map(formatInvitation);
  }

  async createInvitation(
    ctx: RequestContext,
    requestHeaders: Headers,
    body: { email: string; role: string },
  ): Promise<InvitationResponse> {
    const role = requireAssignableRole(body.role);
    const invitation = await this.auth.api.createInvitation({
      body: {
        organizationId: ctx.organizationId,
        email: body.email,
        role,
      },
      headers: requestHeaders,
    });
    if (!invitation) throw new ForbiddenException('Failed to create invitation.');
    return formatInvitation(invitation);
  }

  async revokeInvitation(
    ctx: RequestContext,
    requestHeaders: Headers,
    invitationId: string,
  ): Promise<void> {
    await this.auth.api.cancelInvitation({
      body: { invitationId },
      headers: requestHeaders,
    });
  }

  async transferOwnership(
    ctx: RequestContext,
    requestHeaders: Headers,
    newOwnerUserId: string,
  ): Promise<void> {
    void requestHeaders;
    await this.memberships
      .transferOwnership(ctx.organizationId, ctx.actorId, newOwnerUserId)
      .catch((error: unknown) => {
        if (error instanceof AuthMembershipInvariantError) {
          throw new ForbiddenException(error.message);
        }
        throw error;
      });
  }

  async leaveOrganization(ctx: RequestContext, requestHeaders: Headers): Promise<void> {
    await this.auth.api.leaveOrganization({
      body: { organizationId: ctx.organizationId },
      headers: requestHeaders,
    });
  }
}

function requireAssignableRole(value: string): OrganizationRole {
  if (!isOrganizationRole(value) || value === 'owner') {
    throw new BadRequestException(
      'Role must be one of admin, editor, or viewer. Ownership must be transferred explicitly.',
    );
  }
  return value;
}

// ─── Shape helpers ────────────────────────────────────────────────────────────

interface OrganizationRecord {
  id: string;
  name: string;
  slug?: string | null;
  createdAt?: Date | string;
}

interface MemberRecord {
  id: string;
  userId: string;
  role: string;
  createdAt?: Date | string;
}

interface InvitationRecord {
  id: string;
  email: string;
  role?: string | null;
  status: string;
  expiresAt?: Date | string;
}

function formatOrg(org: OrganizationRecord): OrganizationResponse {
  return {
    id: org.id,
    name: org.name,
    slug: org.slug ?? null,
    createdAt: toIso(org.createdAt),
  };
}

function formatMember(m: MemberRecord): MemberResponse {
  return {
    id: m.id,
    userId: m.userId,
    role: m.role,
    createdAt: toIso(m.createdAt),
  };
}

function formatInvitation(inv: InvitationRecord): InvitationResponse {
  return {
    id: inv.id,
    email: inv.email,
    role: inv.role ?? null,
    status: inv.status,
    expiresAt: toIso(inv.expiresAt),
  };
}

function toIso(value: Date | string | undefined | null): string {
  if (!value) return new Date().toISOString();
  return value instanceof Date ? value.toISOString() : value;
}
