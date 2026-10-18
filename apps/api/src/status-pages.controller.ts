import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Put, Req } from '@nestjs/common';
import type { StatusPageRecord } from '@watchrail/db';
import type { RequestWithContext } from './request-context.js';
import { StatusPagesService } from './status-pages.service.js';
import { RequirePermission } from './auth.guard.js';
import { PERMISSIONS } from './permissions.js';

@Controller('status-pages')
export class StatusPagesController {
  constructor(private readonly pages: StatusPagesService) {}

  @Post()
  @RequirePermission(PERMISSIONS.STATUS_PAGE_MANAGE)
  async create(@Req() request: RequestWithContext, @Body() body: unknown) {
    return { data: toResponse(await this.pages.create(request.watchrailContext, body)) };
  }

  @Get()
  @RequirePermission(PERMISSIONS.STATUS_PAGE_READ)
  async list(@Req() request: RequestWithContext) {
    return { data: (await this.pages.list(request.watchrailContext)).map(toResponse) };
  }

  @Get(':statusPageId')
  @RequirePermission(PERMISSIONS.STATUS_PAGE_READ)
  async find(
    @Req() request: RequestWithContext,
    @Param('statusPageId', ParseUUIDPipe) statusPageId: string,
  ) {
    return { data: toResponse(await this.pages.find(request.watchrailContext, statusPageId)) };
  }

  @Patch(':statusPageId/settings')
  @RequirePermission(PERMISSIONS.STATUS_PAGE_MANAGE)
  async updateSettings(
    @Req() request: RequestWithContext,
    @Param('statusPageId', ParseUUIDPipe) statusPageId: string,
    @Body() body: unknown,
  ) {
    return {
      data: toResponse(
        await this.pages.updateSettings(request.watchrailContext, statusPageId, body),
      ),
    };
  }

  @Put(':statusPageId/components')
  @RequirePermission(PERMISSIONS.STATUS_PAGE_MANAGE)
  async replaceComponents(
    @Req() request: RequestWithContext,
    @Param('statusPageId', ParseUUIDPipe) statusPageId: string,
    @Body() body: unknown,
  ) {
    return {
      data: toResponse(
        await this.pages.replaceComponents(request.watchrailContext, statusPageId, body),
      ),
    };
  }

  @Patch(':statusPageId/publication')
  @RequirePermission(PERMISSIONS.STATUS_PAGE_MANAGE)
  async setPublished(
    @Req() request: RequestWithContext,
    @Param('statusPageId', ParseUUIDPipe) statusPageId: string,
    @Body() body: unknown,
  ) {
    return {
      data: toResponse(await this.pages.setPublished(request.watchrailContext, statusPageId, body)),
    };
  }
}

function toResponse(page: StatusPageRecord) {
  return {
    id: page.id,
    name: page.name,
    slug: page.slug,
    published: page.published,
    components: page.components,
    createdAt: page.createdAt.toISOString(),
    updatedAt: page.updatedAt.toISOString(),
  };
}
