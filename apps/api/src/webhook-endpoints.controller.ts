import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import type {
  WebhookDeliveryDetail,
  WebhookDeliveryListItem,
  WebhookEndpointRecord,
} from '@watchrail/db';
import type { RequestWithContext } from './request-context.js';
import { WebhookEndpointsService } from './webhook-endpoints.service.js';

@Controller('webhook-endpoints')
export class WebhookEndpointsController {
  constructor(private readonly endpoints: WebhookEndpointsService) {}

  @Post()
  async create(@Req() request: RequestWithContext, @Body() body: unknown) {
    return { data: toResponse(await this.endpoints.create(request.watchrailContext, body)) };
  }

  @Get()
  async list(@Req() request: RequestWithContext) {
    return {
      data: (await this.endpoints.list(request.watchrailContext)).map(toResponse),
    };
  }

  @Get(':endpointId/deliveries')
  async listDeliveries(
    @Req() request: RequestWithContext,
    @Param('endpointId', ParseUUIDPipe) endpointId: string,
    @Query() query: Record<string, unknown>,
  ) {
    const page = await this.endpoints.listDeliveries(request.watchrailContext, endpointId, query);
    return {
      data: page.items.map(toDeliveryResponse),
      page: { nextCursor: page.nextCursor },
    };
  }

  @Get(':endpointId/deliveries/:deliveryId')
  async findDelivery(
    @Req() request: RequestWithContext,
    @Param('endpointId', ParseUUIDPipe) endpointId: string,
    @Param('deliveryId', ParseUUIDPipe) deliveryId: string,
  ) {
    return {
      data: toDeliveryDetailResponse(
        await this.endpoints.findDelivery(request.watchrailContext, endpointId, deliveryId),
      ),
    };
  }

  @Get(':endpointId')
  async find(
    @Req() request: RequestWithContext,
    @Param('endpointId', ParseUUIDPipe) endpointId: string,
  ) {
    return {
      data: toResponse(await this.endpoints.find(request.watchrailContext, endpointId)),
    };
  }

  @Patch(':endpointId/settings')
  async updateSettings(
    @Req() request: RequestWithContext,
    @Param('endpointId', ParseUUIDPipe) endpointId: string,
    @Body() body: unknown,
  ) {
    return {
      data: toResponse(
        await this.endpoints.updateSettings(request.watchrailContext, endpointId, body),
      ),
    };
  }

  @Patch(':endpointId/enabled')
  async setEnabled(
    @Req() request: RequestWithContext,
    @Param('endpointId', ParseUUIDPipe) endpointId: string,
    @Body() body: unknown,
  ) {
    return {
      data: toResponse(await this.endpoints.setEnabled(request.watchrailContext, endpointId, body)),
    };
  }
}

function toResponse(endpoint: WebhookEndpointRecord) {
  return {
    id: endpoint.id,
    name: endpoint.name,
    url: endpoint.url,
    enabled: endpoint.enabled,
    versionNumber: endpoint.versionNumber,
    signingSecret: { hasValue: true as const },
    createdAt: endpoint.createdAt.toISOString(),
    updatedAt: endpoint.updatedAt.toISOString(),
  };
}

function toDeliveryResponse(delivery: WebhookDeliveryListItem) {
  return {
    ...delivery,
    event: { ...delivery.event, occurredAt: delivery.event.occurredAt.toISOString() },
    lastAttemptAt: delivery.lastAttemptAt?.toISOString() ?? null,
    nextAttemptAt: delivery.nextAttemptAt?.toISOString() ?? null,
    leaseExpiresAt: delivery.leaseExpiresAt?.toISOString() ?? null,
    deliveredAt: delivery.deliveredAt?.toISOString() ?? null,
    deadAt: delivery.deadAt?.toISOString() ?? null,
    createdAt: delivery.createdAt.toISOString(),
  };
}

function toDeliveryDetailResponse(delivery: WebhookDeliveryDetail) {
  return {
    ...toDeliveryResponse(delivery),
    endpointId: delivery.endpointId,
    endpointVersion: delivery.endpointVersion,
    triggeringRoundId: delivery.triggeringRoundId,
  };
}
