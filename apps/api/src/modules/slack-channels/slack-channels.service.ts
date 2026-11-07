import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  SlackChannelInputError,
  SlackChannelNotFoundError,
  SlackChannelRepository,
  SlackChannelTestRateLimitError,
  SlackDeliveryChannelNotFoundError,
  SlackDeliveryReadRepository,
  type SlackChannelRecord,
  type SlackDeliveryListItem,
} from '@watchrail/db';
import {
  encryptSlackWebhookUrl,
  SlackWebhookUrlInputError,
  type WebhookSigningSecretKeyring,
} from '@watchrail/webhook-security';
import type { RequestContext } from '../../auth/request-context.js';
import { APP_CONFIG, type AppConfig } from '../../config/config.js';
import type {
  CreateSlackChannelInput,
  SetSlackChannelEnabledInput,
  UpdateSlackChannelInput,
} from './dto/slack-channel-input.js';

@Injectable()
export class SlackChannelsService {
  private readonly keyring: WebhookSigningSecretKeyring;

  constructor(
    @Inject(SlackChannelRepository) private readonly channels: SlackChannelRepository,
    @Inject(SlackDeliveryReadRepository)
    private readonly deliveries: SlackDeliveryReadRepository,
    @Inject(APP_CONFIG) config: AppConfig,
  ) {
    this.keyring = config.webhookSigningSecretKeyring;
  }

  async create(
    context: RequestContext,
    input: CreateSlackChannelInput,
  ): Promise<SlackChannelRecord> {
    try {
      return await this.channels.create(
        context.organizationId,
        {
          projectId: input.projectId,
          name: input.name,
          routing: input.routing,
          ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
        },
        ({ channelId, versionNumber }) =>
          encryptSlackWebhookUrl(
            input.webhookUrl,
            { organizationId: context.organizationId, channelId, versionNumber },
            this.keyring,
          ),
      );
    } catch (error) {
      this.translate(error);
    }
  }

  list(context: RequestContext, projectId: string): Promise<SlackChannelRecord[]> {
    return this.channels.listForProject(context.organizationId, projectId);
  }

  async find(context: RequestContext, channelId: string): Promise<SlackChannelRecord> {
    const channel = await this.channels.findForOrganization(context.organizationId, channelId);
    if (!channel)
      throw new NotFoundException({ code: 'NOT_FOUND', message: 'Slack channel not found.' });
    return channel;
  }

  async update(
    context: RequestContext,
    channelId: string,
    input: UpdateSlackChannelInput,
  ): Promise<SlackChannelRecord> {
    try {
      return await this.channels.updateConfiguration(
        context.organizationId,
        channelId,
        {
          name: input.name,
          replaceWebhookUrl: 'value' in input.webhookUrl,
          routing: input.routing,
        },
        ({ versionNumber }) => {
          if (!('value' in input.webhookUrl))
            throw new SlackChannelInputError({
              webhookUrl: ['A replacement Slack webhook URL is required.'],
            });
          return encryptSlackWebhookUrl(
            input.webhookUrl.value,
            { organizationId: context.organizationId, channelId, versionNumber },
            this.keyring,
          );
        },
      );
    } catch (error) {
      this.translate(error);
    }
  }

  async setEnabled(
    context: RequestContext,
    channelId: string,
    input: SetSlackChannelEnabledInput,
  ): Promise<SlackChannelRecord> {
    try {
      return await this.channels.setEnabled(context.organizationId, channelId, input.enabled);
    } catch (error) {
      this.translate(error);
    }
  }

  async test(context: RequestContext, channelId: string): Promise<{ deliveryId: string }> {
    try {
      return await this.channels.stageTest(context.organizationId, channelId);
    } catch (error) {
      this.translate(error);
    }
  }

  async remove(context: RequestContext, channelId: string): Promise<void> {
    try {
      await this.channels.archive(context.organizationId, channelId);
    } catch (error) {
      this.translate(error);
    }
  }

  async listDeliveries(
    context: RequestContext,
    channelId: string,
    limit: number,
  ): Promise<SlackDeliveryListItem[]> {
    try {
      return await this.deliveries.listForChannel(context.organizationId, channelId, limit);
    } catch (error) {
      this.translate(error);
    }
  }

  private translate(error: unknown): never {
    if (error instanceof SlackWebhookUrlInputError)
      throw new BadRequestException({
        code: 'VALIDATION_FAILED',
        message: 'Slack channel settings are invalid.',
        fields: { webhookUrl: [error.message] },
      });
    if (error instanceof SlackChannelInputError)
      throw new BadRequestException({
        code: 'VALIDATION_FAILED',
        message: error.message,
        fields: error.fields,
      });
    if (
      error instanceof SlackChannelNotFoundError ||
      error instanceof SlackDeliveryChannelNotFoundError
    )
      throw new NotFoundException({ code: 'NOT_FOUND', message: 'Slack channel not found.' });
    if (error instanceof SlackChannelTestRateLimitError)
      throw new HttpException(
        {
          code: 'RATE_LIMITED',
          message: error.message,
          retryAfterSeconds: error.retryAfterSeconds,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    throw error;
  }
}
