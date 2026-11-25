import {
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
} from '@nestjs/common';
import { RequirePermission } from '../../auth/auth.guard.js';
import { PERMISSIONS } from '../../auth/permissions.js';
import type { RequestWithContext } from '../../auth/request-context.js';
import { StatusDomainsService } from './status-domains.service.js';

@Controller('status-pages/:pageId/domain')
export class StatusDomainsController {
  constructor(@Inject(StatusDomainsService) private readonly domains: StatusDomainsService) {}
  @Get()
  @RequirePermission(PERMISSIONS.STATUS_PAGE_READ)
  async find(@Req() req: RequestWithContext, @Param('pageId', ParseUUIDPipe) page: string) {
    return { data: await this.domains.find(req.watchrailContext.organizationId, page) };
  }
  @Post()
  @RequirePermission(PERMISSIONS.STATUS_PAGE_MANAGE)
  async attach(
    @Req() req: RequestWithContext,
    @Param('pageId', ParseUUIDPipe) page: string,
    @Body() body: unknown,
  ) {
    const hostname =
      body && typeof body === 'object' ? (body as Record<string, unknown>).hostname : undefined;
    return { data: await this.domains.attach(req.watchrailContext.organizationId, page, hostname) };
  }
  @Post('verify')
  @RequirePermission(PERMISSIONS.STATUS_PAGE_MANAGE)
  async verify(@Req() req: RequestWithContext, @Param('pageId', ParseUUIDPipe) page: string) {
    return { data: await this.domains.verify(req.watchrailContext.organizationId, page) };
  }
  @Delete()
  @RequirePermission(PERMISSIONS.STATUS_PAGE_MANAGE)
  async remove(@Req() req: RequestWithContext, @Param('pageId', ParseUUIDPipe) page: string) {
    return { data: await this.domains.remove(req.watchrailContext.organizationId, page) };
  }
}
