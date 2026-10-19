import {
  BadRequestException,
  Inject,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import {
  WebhookDeliveryEndpointNotFoundError,
  WebhookDeliveryHistoryQueryError,
  WebhookDeliveryReadRepository,
  WebhookEndpointInputError,
  WebhookEndpointNotFoundError,
  WebhookEndpointRepository,
  parseWebhookDeliveryHistoryQuery,
  type WebhookDeliveryDetail,
  type WebhookDeliveryPage,
  type WebhookEndpointRecord,
} from '@watchrail/db';
import {
  decryptWebhookSigningSecret,
  encryptWebhookSigningSecret,
  StoredWebhookSigningSecretResolutionError,
  WebhookSigningSecretInputError,
} from '@watchrail/webhook-security';
import { APP_CONFIG, type AppConfig } from '../../config.js';
import type { RequestContext } from '../../request-context.js';
import type {
  CreateWebhookEndpointInput,
  SetWebhookEndpointEnabledInput,
  UpdateWebhookEndpointSettingsInput,
} from './dto/webhook-endpoint-input.js';

@Injectable()
export class WebhookEndpointsService {
  constructor(
    @Inject(WebhookEndpointRepository)
    private readonly endpoints: WebhookEndpointRepository,
    @Inject(WebhookDeliveryReadRepository)
    private readonly deliveries: WebhookDeliveryReadRepository,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async create(
    context: RequestContext,
    input: CreateWebhookEndpointInput,
  ): Promise<WebhookEndpointRecord> {
    try {
      return await this.endpoints.create(
        context.organizationId,
        {
          name: input.name,
          url: input.url,
          ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
        },
        ({ endpointId, versionNumber }) =>
          encryptWebhookSigningSecret(
            input.signingSecret,
            { organizationId: context.organizationId, endpointId, versionNumber },
            this.config.webhookSigningSecretKeyring,
          ),
      );
    } catch (error) {
      this.translate(error);
    }
  }

  list(context: RequestContext): Promise<WebhookEndpointRecord[]> {
    return this.endpoints.listForOrganization(context.organizationId);
  }

  async listDeliveries(
    context: RequestContext,
    endpointId: string,
    value: Record<string, unknown>,
  ): Promise<WebhookDeliveryPage> {
    try {
      return await this.deliveries.listForEndpoint(
        context.organizationId,
        endpointId,
        parseWebhookDeliveryHistoryQuery(value),
      );
    } catch (error) {
      this.translateReadError(error);
    }
  }

  async findDelivery(
    context: RequestContext,
    endpointId: string,
    deliveryId: string,
  ): Promise<WebhookDeliveryDetail> {
    try {
      const delivery = await this.deliveries.findForEndpoint(
        context.organizationId,
        endpointId,
        deliveryId,
      );
      if (!delivery) this.deliveryNotFound();
      return delivery;
    } catch (error) {
      this.translateReadError(error);
    }
  }

  async find(context: RequestContext, endpointId: string): Promise<WebhookEndpointRecord> {
    const endpoint = await this.endpoints.findForOrganization(context.organizationId, endpointId);
    if (!endpoint) this.notFound();
    return endpoint;
  }

  async updateSettings(
    context: RequestContext,
    endpointId: string,
    input: UpdateWebhookEndpointSettingsInput,
  ): Promise<WebhookEndpointRecord> {
    try {
      return await this.endpoints.updateSettings(
        context.organizationId,
        endpointId,
        {
          name: input.name,
          url: input.url,
          rotateSecret: 'value' in input.signingSecret,
        },
        ({ versionNumber, current }) => {
          if (!current) throw new Error('Current webhook endpoint version is missing.');
          const plaintext =
            'value' in input.signingSecret
              ? input.signingSecret.value
              : decryptWebhookSigningSecret(
                  current.signingSecretEnvelope,
                  {
                    organizationId: context.organizationId,
                    endpointId,
                    versionNumber: current.versionNumber,
                  },
                  this.config.webhookSigningSecretKeyring,
                );
          return encryptWebhookSigningSecret(
            plaintext,
            { organizationId: context.organizationId, endpointId, versionNumber },
            this.config.webhookSigningSecretKeyring,
          );
        },
      );
    } catch (error) {
      this.translate(error);
    }
  }

  async setEnabled(
    context: RequestContext,
    endpointId: string,
    input: SetWebhookEndpointEnabledInput,
  ): Promise<WebhookEndpointRecord> {
    try {
      return await this.endpoints.setEnabled(context.organizationId, endpointId, input.enabled);
    } catch (error) {
      this.translate(error);
    }
  }

  private translate(error: unknown): never {
    if (error instanceof WebhookEndpointNotFoundError) this.notFound();
    if (error instanceof WebhookEndpointInputError)
      throw new BadRequestException({
        code: 'VALIDATION_FAILED',
        message: error.message,
        fields: error.fields,
      });
    if (error instanceof WebhookSigningSecretInputError)
      throw new BadRequestException({
        code: 'VALIDATION_FAILED',
        message: 'Webhook endpoint settings are invalid.',
        fields: { signingSecret: [error.message] },
      });
    if (error instanceof StoredWebhookSigningSecretResolutionError)
      throw new InternalServerErrorException({
        code: 'WEBHOOK_SECRET_UNAVAILABLE',
        message: 'Webhook endpoint configuration could not be updated.',
      });
    throw error;
  }

  private translateReadError(error: unknown): never {
    if (error instanceof WebhookDeliveryEndpointNotFoundError) this.notFound();
    if (error instanceof WebhookDeliveryHistoryQueryError)
      throw new BadRequestException({
        code: 'VALIDATION_FAILED',
        message: error.message,
      });
    throw error;
  }

  private deliveryNotFound(): never {
    throw new NotFoundException({
      code: 'WEBHOOK_DELIVERY_NOT_FOUND',
      message: 'Webhook delivery not found.',
    });
  }

  private notFound(): never {
    throw new NotFoundException({
      code: 'WEBHOOK_ENDPOINT_NOT_FOUND',
      message: 'Webhook endpoint not found.',
    });
  }
}
