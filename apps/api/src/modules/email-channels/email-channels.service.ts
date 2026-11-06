import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  EmailChannelInputError,
  EmailChannelNotFoundError,
  EmailChannelRepository,
  EmailChannelTestRateLimitError,
  EmailDeliveryChannelNotFoundError,
  EmailDeliveryReadRepository,
  type EmailChannelRecord,
  type EmailDeliveryListItem,
} from '@watchrail/db';
import type { RequestContext } from '../../auth/request-context.js';
import type {
  CreateEmailChannelInput,
  SetEmailChannelEnabledInput,
  UpdateEmailChannelInput,
} from './dto/email-channel-input.js';

@Injectable()
export class EmailChannelsService {
  constructor(
    @Inject(EmailChannelRepository) private readonly channels: EmailChannelRepository,
    @Inject(EmailDeliveryReadRepository) private readonly deliveries: EmailDeliveryReadRepository,
  ) {}

  async create(
    context: RequestContext,
    input: CreateEmailChannelInput,
  ): Promise<EmailChannelRecord> {
    try {
      return await this.channels.create(context.organizationId, {
        projectId: input.projectId,
        name: input.name,
        recipientEmails: input.recipientEmails,
        routing: input.routing,
        ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
      });
    } catch (error) {
      this.translate(error);
    }
  }

  list(context: RequestContext, projectId: string): Promise<EmailChannelRecord[]> {
    return this.channels.listForProject(context.organizationId, projectId);
  }

  async find(context: RequestContext, channelId: string): Promise<EmailChannelRecord> {
    const channel = await this.channels.findForOrganization(context.organizationId, channelId);
    if (!channel)
      throw new NotFoundException({ code: 'NOT_FOUND', message: 'Email channel not found.' });
    return channel;
  }

  async update(
    context: RequestContext,
    channelId: string,
    input: UpdateEmailChannelInput,
  ): Promise<EmailChannelRecord> {
    try {
      return await this.channels.updateConfiguration(context.organizationId, channelId, input);
    } catch (error) {
      this.translate(error);
    }
  }

  async setEnabled(
    context: RequestContext,
    channelId: string,
    input: SetEmailChannelEnabledInput,
  ): Promise<EmailChannelRecord> {
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

  async listDeliveries(
    context: RequestContext,
    channelId: string,
    limit: number,
  ): Promise<EmailDeliveryListItem[]> {
    try {
      return await this.deliveries.listForChannel(context.organizationId, channelId, limit);
    } catch (error) {
      this.translate(error);
    }
  }

  private translate(error: unknown): never {
    if (error instanceof EmailChannelInputError)
      throw new BadRequestException({
        code: 'VALIDATION_FAILED',
        message: error.message,
        fields: error.fields,
      });
    if (
      error instanceof EmailChannelNotFoundError ||
      error instanceof EmailDeliveryChannelNotFoundError
    )
      throw new NotFoundException({ code: 'NOT_FOUND', message: 'Email channel not found.' });
    if (error instanceof EmailChannelTestRateLimitError)
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
