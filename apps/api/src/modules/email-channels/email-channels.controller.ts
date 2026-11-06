import {
  Body,
  Controller,
  Get,
  Inject,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { PERMISSIONS } from '../../auth/permissions.js';
import { RequirePermission } from '../../auth/auth.guard.js';
import type { RequestWithContext } from '../../auth/request-context.js';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';
import {
  createEmailChannelSchema,
  emailDeliveryQuerySchema,
  setEmailChannelEnabledSchema,
  updateEmailChannelSchema,
  type CreateEmailChannelInput,
  type EmailDeliveryQuery,
  type SetEmailChannelEnabledInput,
  type UpdateEmailChannelInput,
} from './dto/email-channel-input.js';
import { presentEmailChannel, presentEmailDelivery } from './email-channels.presenter.js';
import { EmailChannelsService } from './email-channels.service.js';

@Controller('email-channels')
export class EmailChannelsController {
  constructor(@Inject(EmailChannelsService) private readonly channels: EmailChannelsService) {}

  @Post()
  @RequirePermission(PERMISSIONS.NOTIFICATION_MANAGE)
  async create(
    @Req() request: RequestWithContext,
    @Body(new ZodValidationPipe(createEmailChannelSchema, 'body')) input: CreateEmailChannelInput,
  ) {
    return {
      data: presentEmailChannel(await this.channels.create(request.watchrailContext, input)),
    };
  }

  @Get()
  @RequirePermission(PERMISSIONS.NOTIFICATION_READ)
  async list(
    @Req() request: RequestWithContext,
    @Query('projectId', ParseUUIDPipe) projectId: string,
  ) {
    return {
      data: (await this.channels.list(request.watchrailContext, projectId)).map(
        presentEmailChannel,
      ),
    };
  }

  @Get(':channelId')
  @RequirePermission(PERMISSIONS.NOTIFICATION_READ)
  async find(
    @Req() request: RequestWithContext,
    @Param('channelId', ParseUUIDPipe) channelId: string,
  ) {
    return {
      data: presentEmailChannel(await this.channels.find(request.watchrailContext, channelId)),
    };
  }

  @Patch(':channelId')
  @RequirePermission(PERMISSIONS.NOTIFICATION_MANAGE)
  async update(
    @Req() request: RequestWithContext,
    @Param('channelId', ParseUUIDPipe) channelId: string,
    @Body(new ZodValidationPipe(updateEmailChannelSchema, 'body')) input: UpdateEmailChannelInput,
  ) {
    return {
      data: presentEmailChannel(
        await this.channels.update(request.watchrailContext, channelId, input),
      ),
    };
  }

  @Patch(':channelId/enabled')
  @RequirePermission(PERMISSIONS.NOTIFICATION_MANAGE)
  async setEnabled(
    @Req() request: RequestWithContext,
    @Param('channelId', ParseUUIDPipe) channelId: string,
    @Body(new ZodValidationPipe(setEmailChannelEnabledSchema, 'body'))
    input: SetEmailChannelEnabledInput,
  ) {
    return {
      data: presentEmailChannel(
        await this.channels.setEnabled(request.watchrailContext, channelId, input),
      ),
    };
  }

  @Post(':channelId/test')
  @RequirePermission(PERMISSIONS.NOTIFICATION_MANAGE)
  async test(
    @Req() request: RequestWithContext,
    @Param('channelId', ParseUUIDPipe) channelId: string,
  ) {
    return { data: await this.channels.test(request.watchrailContext, channelId) };
  }

  @Get(':channelId/deliveries')
  @RequirePermission(PERMISSIONS.NOTIFICATION_READ)
  async listDeliveries(
    @Req() request: RequestWithContext,
    @Param('channelId', ParseUUIDPipe) channelId: string,
    @Query(new ZodValidationPipe(emailDeliveryQuerySchema, 'query')) query: EmailDeliveryQuery,
  ) {
    return {
      data: (
        await this.channels.listDeliveries(request.watchrailContext, channelId, query.limit ?? 25)
      ).map(presentEmailDelivery),
    };
  }
}
