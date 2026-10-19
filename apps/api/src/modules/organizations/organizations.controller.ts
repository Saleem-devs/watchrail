import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import { RequirePermission } from '../../auth.guard.js';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';
import { PERMISSIONS } from '../../permissions.js';
import type { RequestWithContext } from '../../request-context.js';
import {
  createInvitationSchema,
  transferOwnershipSchema,
  updateMemberRoleSchema,
  updateOrganizationSchema,
  type CreateInvitationInput,
  type TransferOwnershipInput,
  type UpdateMemberRoleInput,
  type UpdateOrganizationInput,
} from './dto/organization-input.js';
import {
  presentInvitation,
  presentMember,
  presentOrganization,
} from './organizations.presenter.js';
import { OrganizationsService } from './organizations.service.js';

@Controller('organizations')
export class OrganizationsController {
  constructor(@Inject(OrganizationsService) private readonly orgs: OrganizationsService) {}

  @Get()
  @RequirePermission(PERMISSIONS.ORGANIZATION_READ)
  async listOrganizations(@Req() request: RequestWithContext) {
    return {
      data: (
        await this.orgs.listOrganizations(request.watchrailContext, buildHeaders(request))
      ).map(presentOrganization),
    };
  }

  @Get('current')
  @RequirePermission(PERMISSIONS.ORGANIZATION_READ)
  async getOrganization(@Req() request: RequestWithContext) {
    return {
      data: presentOrganization(
        await this.orgs.getOrganization(request.watchrailContext, buildHeaders(request)),
      ),
    };
  }

  @Patch('current')
  @RequirePermission(PERMISSIONS.ORGANIZATION_UPDATE)
  async updateOrganization(
    @Req() request: RequestWithContext,
    @Body(new ZodValidationPipe(updateOrganizationSchema, 'body'))
    input: UpdateOrganizationInput,
  ) {
    return {
      data: presentOrganization(
        await this.orgs.updateOrganization(request.watchrailContext, buildHeaders(request), input),
      ),
    };
  }

  @Delete('current')
  @HttpCode(204)
  @RequirePermission(PERMISSIONS.ORGANIZATION_DELETE)
  async deleteOrganization(@Req() request: RequestWithContext) {
    await this.orgs.deleteOrganization(request.watchrailContext, buildHeaders(request));
  }

  @Post('current/leave')
  @HttpCode(204)
  @RequirePermission(PERMISSIONS.ORGANIZATION_READ)
  async leaveOrganization(@Req() request: RequestWithContext) {
    await this.orgs.leaveOrganization(request.watchrailContext, buildHeaders(request));
  }

  @Post('current/transfer-ownership')
  @HttpCode(204)
  @RequirePermission(PERMISSIONS.ORGANIZATION_TRANSFER)
  async transferOwnership(
    @Req() request: RequestWithContext,
    @Body(new ZodValidationPipe(transferOwnershipSchema, 'body'))
    input: TransferOwnershipInput,
  ) {
    await this.orgs.transferOwnership(
      request.watchrailContext,
      buildHeaders(request),
      input.userId,
    );
  }

  @Get('current/members')
  @RequirePermission(PERMISSIONS.MEMBER_READ)
  async listMembers(@Req() request: RequestWithContext) {
    return {
      data: (await this.orgs.listMembers(request.watchrailContext, buildHeaders(request))).map(
        presentMember,
      ),
    };
  }

  @Patch('current/members/:memberId/role')
  @RequirePermission(PERMISSIONS.MEMBER_UPDATE_ROLE)
  async updateMemberRole(
    @Req() request: RequestWithContext,
    @Param('memberId') memberId: string,
    @Body(new ZodValidationPipe(updateMemberRoleSchema, 'body'))
    input: UpdateMemberRoleInput,
  ) {
    return {
      data: presentMember(
        await this.orgs.updateMemberRole(
          request.watchrailContext,
          buildHeaders(request),
          memberId,
          input.role,
        ),
      ),
    };
  }

  @Delete('current/members/:memberId')
  @HttpCode(204)
  @RequirePermission(PERMISSIONS.MEMBER_REMOVE)
  async removeMember(@Req() request: RequestWithContext, @Param('memberId') memberId: string) {
    await this.orgs.removeMember(request.watchrailContext, buildHeaders(request), memberId);
  }

  @Get('current/invitations')
  @RequirePermission(PERMISSIONS.MEMBER_READ)
  async listInvitations(@Req() request: RequestWithContext) {
    return {
      data: (await this.orgs.listInvitations(request.watchrailContext, buildHeaders(request))).map(
        presentInvitation,
      ),
    };
  }

  @Post('current/invitations')
  @RequirePermission(PERMISSIONS.MEMBER_INVITE)
  async createInvitation(
    @Req() request: RequestWithContext,
    @Body(new ZodValidationPipe(createInvitationSchema, 'body'))
    input: CreateInvitationInput,
  ) {
    return {
      data: presentInvitation(
        await this.orgs.createInvitation(request.watchrailContext, buildHeaders(request), input),
      ),
    };
  }

  @Delete('current/invitations/:invitationId')
  @HttpCode(204)
  @RequirePermission(PERMISSIONS.MEMBER_INVITE)
  async revokeInvitation(
    @Req() request: RequestWithContext,
    @Param('invitationId') invitationId: string,
  ) {
    await this.orgs.revokeInvitation(request.watchrailContext, buildHeaders(request), invitationId);
  }
}

function buildHeaders(request: Request): Headers {
  const headers = new Headers();
  const cookie = request.headers.cookie;
  if (cookie) headers.set('cookie', cookie);
  const auth = request.headers.authorization;
  if (auth) headers.set('authorization', auth);
  return headers;
}
