/**
 * OrganizationsController — REST API for organization management.
 *
 * All endpoints require authentication (global WatchrailAuthGuard) and
 * specific permissions (via @RequirePermission). The requestHeaders
 * forwarded to OrganizationsService preserve the session cookie so that
 * Better Auth's organization plugin can validate the caller's session.
 */

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
import { OrganizationsService } from './organizations.service.js';
import { RequirePermission } from './auth.guard.js';
import { PERMISSIONS } from './permissions.js';
import type { RequestWithContext } from './request-context.js';

@Controller('organizations')
export class OrganizationsController {
  constructor(@Inject(OrganizationsService) private readonly orgs: OrganizationsService) {}

  // ─── Organization ─────────────────────────────────────────────────────────

  @Get()
  @RequirePermission(PERMISSIONS.ORGANIZATION_READ)
  async listOrganizations(@Req() request: RequestWithContext) {
    return {
      data: await this.orgs.listOrganizations(request.watchrailContext, buildHeaders(request)),
    };
  }

  @Get('current')
  @RequirePermission(PERMISSIONS.ORGANIZATION_READ)
  async getOrganization(@Req() request: RequestWithContext) {
    return {
      data: await this.orgs.getOrganization(request.watchrailContext, buildHeaders(request)),
    };
  }

  @Patch('current')
  @RequirePermission(PERMISSIONS.ORGANIZATION_UPDATE)
  async updateOrganization(
    @Req() request: RequestWithContext,
    @Body() body: { name?: string; slug?: string },
  ) {
    return {
      data: await this.orgs.updateOrganization(
        request.watchrailContext,
        buildHeaders(request),
        body,
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
  async transferOwnership(@Req() request: RequestWithContext, @Body() body: { userId: string }) {
    await this.orgs.transferOwnership(request.watchrailContext, buildHeaders(request), body.userId);
  }

  // ─── Members ──────────────────────────────────────────────────────────────

  @Get('current/members')
  @RequirePermission(PERMISSIONS.MEMBER_READ)
  async listMembers(@Req() request: RequestWithContext) {
    return {
      data: await this.orgs.listMembers(request.watchrailContext, buildHeaders(request)),
    };
  }

  @Patch('current/members/:memberId/role')
  @RequirePermission(PERMISSIONS.MEMBER_UPDATE_ROLE)
  async updateMemberRole(
    @Req() request: RequestWithContext,
    @Param('memberId') memberId: string,
    @Body() body: { role: string },
  ) {
    return {
      data: await this.orgs.updateMemberRole(
        request.watchrailContext,
        buildHeaders(request),
        memberId,
        body.role,
      ),
    };
  }

  @Delete('current/members/:memberId')
  @HttpCode(204)
  @RequirePermission(PERMISSIONS.MEMBER_REMOVE)
  async removeMember(@Req() request: RequestWithContext, @Param('memberId') memberId: string) {
    await this.orgs.removeMember(request.watchrailContext, buildHeaders(request), memberId);
  }

  // ─── Invitations ──────────────────────────────────────────────────────────

  @Get('current/invitations')
  @RequirePermission(PERMISSIONS.MEMBER_READ)
  async listInvitations(@Req() request: RequestWithContext) {
    return {
      data: await this.orgs.listInvitations(request.watchrailContext, buildHeaders(request)),
    };
  }

  @Post('current/invitations')
  @RequirePermission(PERMISSIONS.MEMBER_INVITE)
  async createInvitation(
    @Req() request: RequestWithContext,
    @Body() body: { email: string; role: string },
  ) {
    return {
      data: await this.orgs.createInvitation(request.watchrailContext, buildHeaders(request), body),
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

// ─── Helpers ─────────────────────────────────────────────────────────────────

function buildHeaders(request: Request): Headers {
  const headers = new Headers();
  const cookie = request.headers.cookie;
  if (cookie) headers.set('cookie', cookie);
  const auth = request.headers.authorization;
  if (auth) headers.set('authorization', auth);
  return headers;
}
