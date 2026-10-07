import {
  BadRequestException,
  Inject,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import {
  WebhookEndpointInputError,
  WebhookEndpointNotFoundError,
  WebhookEndpointRepository,
  WebhookDeliveryEndpointNotFoundError,
  WebhookDeliveryHistoryQueryError,
  WebhookDeliveryReadRepository,
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
import { APP_CONFIG, type AppConfig } from './config.js';
import type { RequestContext } from './request-context.js';

type SecretUpdate = { type: 'RETAIN' } | { type: 'VALUE'; value: string };

@Injectable()
export class WebhookEndpointsService {
  constructor(
    @Inject(WebhookEndpointRepository)
    private readonly endpoints: WebhookEndpointRepository,
    @Inject(WebhookDeliveryReadRepository)
    private readonly deliveries: WebhookDeliveryReadRepository,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async create(context: RequestContext, value: unknown): Promise<WebhookEndpointRecord> {
    const input = parseCreateInput(value);
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
    value: unknown,
  ): Promise<WebhookEndpointRecord> {
    const input = parseSettingsInput(value);
    try {
      return await this.endpoints.updateSettings(
        context.organizationId,
        endpointId,
        {
          name: input.name,
          url: input.url,
          rotateSecret: input.signingSecret.type === 'VALUE',
        },
        ({ versionNumber, current }) => {
          if (!current) throw new Error('Current webhook endpoint version is missing.');
          const plaintext =
            input.signingSecret.type === 'VALUE'
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
    value: unknown,
  ): Promise<WebhookEndpointRecord> {
    const enabled = parseEnabledInput(value);
    try {
      return await this.endpoints.setEnabled(context.organizationId, endpointId, enabled);
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

function parseCreateInput(value: unknown): {
  name: string;
  url: string;
  signingSecret: string;
  enabled?: boolean;
} {
  if (!isRecord(value) || !hasOnlyKeys(value, ['name', 'url', 'signingSecret', 'enabled']))
    invalid({ body: ['Request body has an invalid shape.'] });
  if (
    typeof value.name !== 'string' ||
    typeof value.url !== 'string' ||
    typeof value.signingSecret !== 'string' ||
    ('enabled' in value && typeof value.enabled !== 'boolean')
  )
    invalid({ body: ['Request body has invalid field types.'] });
  return {
    name: value.name,
    url: value.url,
    signingSecret: value.signingSecret,
    ...('enabled' in value ? { enabled: value.enabled as boolean } : {}),
  };
}

function parseSettingsInput(value: unknown): {
  name: string;
  url: string;
  signingSecret: SecretUpdate;
} {
  if (!hasExactKeys(value, ['name', 'url', 'signingSecret']))
    invalid({ body: ['Request body must contain exactly name, url, and signingSecret.'] });
  if (typeof value.name !== 'string' || typeof value.url !== 'string')
    invalid({ body: ['Request body has invalid field types.'] });
  const signingSecret = parseSecretUpdate(value.signingSecret);
  return { name: value.name, url: value.url, signingSecret };
}

function parseSecretUpdate(value: unknown): SecretUpdate {
  if (hasExactKeys(value, ['retain']) && value.retain === true) return { type: 'RETAIN' };
  if (hasExactKeys(value, ['value']) && typeof value.value === 'string')
    return { type: 'VALUE', value: value.value };
  invalid({
    signingSecret: ['signingSecret must be exactly { retain: true } or { value: string }.'],
  });
}

function parseEnabledInput(value: unknown): boolean {
  if (!hasExactKeys(value, ['enabled']) || typeof value.enabled !== 'boolean')
    invalid({ enabled: ['enabled must be a boolean.'] });
  return value.enabled;
}

function invalid(fields: Record<string, string[]>): never {
  throw new BadRequestException({
    code: 'VALIDATION_FAILED',
    message: 'Webhook endpoint settings are invalid.',
    fields,
  });
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}
function hasExactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
