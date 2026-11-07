import {
  Body,
  Controller,
  Delete,
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
  createSlackChannelSchema,
  setSlackChannelEnabledSchema,
  slackDeliveryQuerySchema,
  updateSlackChannelSchema,
  type CreateSlackChannelInput,
  type SetSlackChannelEnabledInput,
  type SlackDeliveryQuery,
  type UpdateSlackChannelInput,
} from './dto/slack-channel-input.js';
import { presentSlackChannel, presentSlackDelivery } from './slack-channels.presenter.js';
import { SlackChannelsService } from './slack-channels.service.js';

@Controller('slack-channels')
export class SlackChannelsController {
  constructor(@Inject(SlackChannelsService) private readonly channels: SlackChannelsService) {}

  @Post()
  @RequirePermission(PERMISSIONS.NOTIFICATION_MANAGE)
  async create(
    @Req() request: RequestWithContext,
    @Body(new ZodValidationPipe(createSlackChannelSchema, 'body')) input: CreateSlackChannelInput,
  ) {
    return {
      data: presentSlackChannel(await this.channels.create(request.watchrailContext, input)),
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
        presentSlackChannel,
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
      data: presentSlackChannel(await this.channels.find(request.watchrailContext, channelId)),
    };
  }

  @Patch(':channelId')
  @RequirePermission(PERMISSIONS.NOTIFICATION_MANAGE)
  async update(
    @Req() request: RequestWithContext,
    @Param('channelId', ParseUUIDPipe) channelId: string,
    @Body(new ZodValidationPipe(updateSlackChannelSchema, 'body')) input: UpdateSlackChannelInput,
  ) {
    return {
      data: presentSlackChannel(
        await this.channels.update(request.watchrailContext, channelId, input),
      ),
    };
  }

  @Patch(':channelId/enabled')
  @RequirePermission(PERMISSIONS.NOTIFICATION_MANAGE)
  async setEnabled(
    @Req() request: RequestWithContext,
    @Param('channelId', ParseUUIDPipe) channelId: string,
    @Body(new ZodValidationPipe(setSlackChannelEnabledSchema, 'body'))
    input: SetSlackChannelEnabledInput,
  ) {
    return {
      data: presentSlackChannel(
        await this.channels.setEnabled(request.watchrailContext, channelId, input),
      ),
    };
  }

  @Delete(':channelId')
  @RequirePermission(PERMISSIONS.NOTIFICATION_MANAGE)
  async remove(
    @Req() request: RequestWithContext,
    @Param('channelId', ParseUUIDPipe) channelId: string,
  ) {
    await this.channels.remove(request.watchrailContext, channelId);
    return { data: { deleted: true } };
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
    @Query(new ZodValidationPipe(slackDeliveryQuerySchema, 'query')) query: SlackDeliveryQuery,
  ) {
    return {
      data: (
        await this.channels.listDeliveries(request.watchrailContext, channelId, query.limit ?? 25)
      ).map(presentSlackDelivery),
    };
  }
}
