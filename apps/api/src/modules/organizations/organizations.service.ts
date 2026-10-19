import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
  ForbiddenException,
} from '@nestjs/common';
import {
  AuthMembershipInvariantError,
  AuthMembershipRepository,
  AuthEmailOutboxRepository,
} from '@watchrail/db';
import { WATCHRAIL_AUTH } from '../../auth.tokens.js';
import type { WatchrailAuth } from '../../auth.js';
import { isOrganizationRole, type OrganizationRole } from '../../permissions.js';
import type { RequestContext } from '../../request-context.js';
import type { CreateInvitationInput, UpdateOrganizationInput } from './dto/organization-input.js';
import type {
  InvitationRecord,
  MemberRecord,
  OrganizationRecord,
} from './organizations.presenter.js';

@Injectable()
export class OrganizationsService {
  constructor(
    @Inject(WATCHRAIL_AUTH) private readonly auth: WatchrailAuth,
    @Inject(AuthMembershipRepository) private readonly memberships: AuthMembershipRepository,
    @Inject(AuthEmailOutboxRepository)
    private readonly authEmailOutbox: AuthEmailOutboxRepository,
  ) {}

  async listOrganizations(
    ctx: RequestContext,
    requestHeaders: Headers,
  ): Promise<OrganizationRecord[]> {
    const result = await this.auth.api.listOrganizations({ headers: requestHeaders });
    if (!Array.isArray(result)) return [];
    return result;
  }

  async getOrganization(ctx: RequestContext, requestHeaders: Headers): Promise<OrganizationRecord> {
    const org = await this.auth.api
      .getFullOrganization({
        query: { organizationId: ctx.organizationId },
        headers: requestHeaders,
      })
      .catch(() => null);

    if (!org) throw new NotFoundException('Organization not found.');
    return org;
  }

  async updateOrganization(
    ctx: RequestContext,
    requestHeaders: Headers,
    body: UpdateOrganizationInput,
  ): Promise<OrganizationRecord> {
    const updated = await this.auth.api.updateOrganization({
      body: {
        organizationId: ctx.organizationId,
        data: body,
      },
      headers: requestHeaders,
    });
    if (!updated) throw new NotFoundException('Organization not found.');
    return updated;
  }

  async deleteOrganization(ctx: RequestContext, requestHeaders: Headers): Promise<void> {
    await this.auth.api.deleteOrganization({
      body: { organizationId: ctx.organizationId },
      headers: requestHeaders,
    });
  }

  async listMembers(ctx: RequestContext, requestHeaders: Headers): Promise<MemberRecord[]> {
    const result = await this.auth.api.listMembers({
      query: { organizationId: ctx.organizationId },
      headers: requestHeaders,
    });
    const members = Array.isArray(result) ? result : result.members;
    return members;
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
  ): Promise<MemberRecord> {
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
    return updated;
  }

  async listInvitations(ctx: RequestContext, requestHeaders: Headers): Promise<InvitationRecord[]> {
    const result = await this.auth.api.listInvitations({
      query: { organizationId: ctx.organizationId },
      headers: requestHeaders,
    });
    if (!Array.isArray(result)) return [];
    return result;
  }

  async createInvitation(
    ctx: RequestContext,
    requestHeaders: Headers,
    body: CreateInvitationInput,
  ): Promise<InvitationRecord> {
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
    return invitation;
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
    // Keep pending mail supersession; the worker independently checks invitation state.
    await this.authEmailOutbox.supersedeInvitation(invitationId);
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
