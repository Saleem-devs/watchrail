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
import { RequirePermission } from '../../auth.guard.js';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';
import { PERMISSIONS } from '../../permissions.js';
import type { RequestWithContext } from '../../request-context.js';
import {
  createWebhookEndpointSchema,
  setWebhookEndpointEnabledSchema,
  updateWebhookEndpointSettingsSchema,
  type CreateWebhookEndpointInput,
  type SetWebhookEndpointEnabledInput,
  type UpdateWebhookEndpointSettingsInput,
} from './dto/webhook-endpoint-input.js';
import {
  presentWebhookDelivery,
  presentWebhookDeliveryDetail,
  presentWebhookEndpoint,
} from './webhook-endpoints.presenter.js';
import { WebhookEndpointsService } from './webhook-endpoints.service.js';

const updateSettingsValidation = new ZodValidationPipe(
  updateWebhookEndpointSettingsSchema,
  'body',
  (issue) => (issue.path[0] === 'signingSecret' ? 'signingSecret' : 'body'),
);

@Controller('webhook-endpoints')
export class WebhookEndpointsController {
  constructor(
    @Inject(WebhookEndpointsService) private readonly endpoints: WebhookEndpointsService,
  ) {}

  @Post()
  @RequirePermission(PERMISSIONS.WEBHOOK_MANAGE)
  async create(
    @Req() request: RequestWithContext,
    @Body(new ZodValidationPipe(createWebhookEndpointSchema, 'body'))
    input: CreateWebhookEndpointInput,
  ) {
    return {
      data: presentWebhookEndpoint(await this.endpoints.create(request.watchrailContext, input)),
    };
  }

  @Get()
  @RequirePermission(PERMISSIONS.WEBHOOK_READ)
  async list(@Req() request: RequestWithContext) {
    return {
      data: (await this.endpoints.list(request.watchrailContext)).map(presentWebhookEndpoint),
    };
  }

  @Get(':endpointId/deliveries')
  @RequirePermission(PERMISSIONS.NOTIFICATION_READ)
  async listDeliveries(
    @Req() request: RequestWithContext,
    @Param('endpointId', ParseUUIDPipe) endpointId: string,
    @Query() query: Record<string, unknown>,
  ) {
    const page = await this.endpoints.listDeliveries(request.watchrailContext, endpointId, query);
    return {
      data: page.items.map(presentWebhookDelivery),
      page: { nextCursor: page.nextCursor },
    };
  }

  @Get(':endpointId/deliveries/:deliveryId')
  @RequirePermission(PERMISSIONS.NOTIFICATION_READ)
  async findDelivery(
    @Req() request: RequestWithContext,
    @Param('endpointId', ParseUUIDPipe) endpointId: string,
    @Param('deliveryId', ParseUUIDPipe) deliveryId: string,
  ) {
    return {
      data: presentWebhookDeliveryDetail(
        await this.endpoints.findDelivery(request.watchrailContext, endpointId, deliveryId),
      ),
    };
  }

  @Get(':endpointId')
  @RequirePermission(PERMISSIONS.WEBHOOK_READ)
  async find(
    @Req() request: RequestWithContext,
    @Param('endpointId', ParseUUIDPipe) endpointId: string,
  ) {
    return {
      data: presentWebhookEndpoint(await this.endpoints.find(request.watchrailContext, endpointId)),
    };
  }

  @Patch(':endpointId/settings')
  @RequirePermission(PERMISSIONS.WEBHOOK_MANAGE)
  async updateSettings(
    @Req() request: RequestWithContext,
    @Param('endpointId', ParseUUIDPipe) endpointId: string,
    @Body(updateSettingsValidation)
    input: UpdateWebhookEndpointSettingsInput,
  ) {
    return {
      data: presentWebhookEndpoint(
        await this.endpoints.updateSettings(request.watchrailContext, endpointId, input),
      ),
    };
  }

  @Patch(':endpointId/enabled')
  @RequirePermission(PERMISSIONS.WEBHOOK_MANAGE)
  async setEnabled(
    @Req() request: RequestWithContext,
    @Param('endpointId', ParseUUIDPipe) endpointId: string,
    @Body(new ZodValidationPipe(setWebhookEndpointEnabledSchema, 'enabled'))
    input: SetWebhookEndpointEnabledInput,
  ) {
    return {
      data: presentWebhookEndpoint(
        await this.endpoints.setEnabled(request.watchrailContext, endpointId, input),
      ),
    };
  }
}
