import {
  Body,
  Controller,
  Get,
  Inject,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
  Req,
} from '@nestjs/common';
import { RequirePermission } from '../../auth/auth.guard.js';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';
import { PERMISSIONS } from '../../auth/permissions.js';
import type { RequestWithContext } from '../../auth/request-context.js';
import {
  createStatusPageSchema,
  replaceStatusPageComponentsSchema,
  setStatusPagePublicationSchema,
  updateStatusPageSettingsSchema,
  type CreateStatusPageInput,
  type ReplaceStatusPageComponentsInput,
  type SetStatusPagePublicationInput,
  type UpdateStatusPageSettingsInput,
} from './dto/status-page-input.js';
import { presentStatusPage } from './status-pages.presenter.js';
import { StatusPagesService } from './status-pages.service.js';

@Controller('status-pages')
export class StatusPagesController {
  constructor(@Inject(StatusPagesService) private readonly pages: StatusPagesService) {}

  @Post()
  @RequirePermission(PERMISSIONS.STATUS_PAGE_MANAGE)
  async create(
    @Req() request: RequestWithContext,
    @Query('projectId', ParseUUIDPipe) projectId: string,
    @Body(new ZodValidationPipe(createStatusPageSchema, 'statusPage'))
    input: CreateStatusPageInput,
  ) {
    return {
      data: presentStatusPage(await this.pages.create(request.watchrailContext, projectId, input)),
    };
  }

  @Get()
  @RequirePermission(PERMISSIONS.STATUS_PAGE_READ)
  async list(
    @Req() request: RequestWithContext,
    @Query('projectId', ParseUUIDPipe) projectId: string,
  ) {
    return {
      data: (await this.pages.list(request.watchrailContext, projectId)).map(presentStatusPage),
    };
  }

  @Get(':statusPageId')
  @RequirePermission(PERMISSIONS.STATUS_PAGE_READ)
  async find(
    @Req() request: RequestWithContext,
    @Param('statusPageId', ParseUUIDPipe) statusPageId: string,
  ) {
    return {
      data: presentStatusPage(await this.pages.find(request.watchrailContext, statusPageId)),
    };
  }

  @Patch(':statusPageId/settings')
  @RequirePermission(PERMISSIONS.STATUS_PAGE_MANAGE)
  async updateSettings(
    @Req() request: RequestWithContext,
    @Param('statusPageId', ParseUUIDPipe) statusPageId: string,
    @Body(new ZodValidationPipe(updateStatusPageSettingsSchema, 'statusPage'))
    input: UpdateStatusPageSettingsInput,
  ) {
    return {
      data: presentStatusPage(
        await this.pages.updateSettings(request.watchrailContext, statusPageId, input),
      ),
    };
  }

  @Put(':statusPageId/components')
  @RequirePermission(PERMISSIONS.STATUS_PAGE_MANAGE)
  async replaceComponents(
    @Req() request: RequestWithContext,
    @Param('statusPageId', ParseUUIDPipe) statusPageId: string,
    @Body(new ZodValidationPipe(replaceStatusPageComponentsSchema, 'components'))
    input: ReplaceStatusPageComponentsInput,
  ) {
    return {
      data: presentStatusPage(
        await this.pages.replaceComponents(request.watchrailContext, statusPageId, input),
      ),
    };
  }

  @Patch(':statusPageId/publication')
  @RequirePermission(PERMISSIONS.STATUS_PAGE_MANAGE)
  async setPublished(
    @Req() request: RequestWithContext,
    @Param('statusPageId', ParseUUIDPipe) statusPageId: string,
    @Body(new ZodValidationPipe(setStatusPagePublicationSchema, 'publication'))
    input: SetStatusPagePublicationInput,
  ) {
    return {
      data: presentStatusPage(
        await this.pages.setPublished(request.watchrailContext, statusPageId, input),
      ),
    };
  }
}
