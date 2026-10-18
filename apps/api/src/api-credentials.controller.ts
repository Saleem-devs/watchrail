import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
} from '@nestjs/common';
import { RequirePermission } from './auth.guard.js';
import { ApiCredentialsService } from './api-credentials.service.js';
import { PERMISSIONS } from './permissions.js';
import type { RequestWithContext } from './request-context.js';

@Controller('api-credentials')
export class ApiCredentialsController {
  constructor(@Inject(ApiCredentialsService) private readonly credentials: ApiCredentialsService) {}

  @Post()
  @RequirePermission(PERMISSIONS.API_KEY_MANAGE)
  async create(@Req() request: RequestWithContext, @Body() body: unknown) {
    const created = await this.credentials.create(request.watchrailContext, body);
    return { data: { ...toResponse(created.record), token: created.token } };
  }

  @Get()
  @RequirePermission(PERMISSIONS.API_KEY_READ)
  async list(@Req() request: RequestWithContext) {
    return { data: (await this.credentials.list(request.watchrailContext)).map(toResponse) };
  }

  @Delete(':credentialId')
  @HttpCode(204)
  @RequirePermission(PERMISSIONS.API_KEY_MANAGE)
  async revoke(
    @Req() request: RequestWithContext,
    @Param('credentialId', ParseUUIDPipe) credentialId: string,
  ) {
    await this.credentials.revoke(request.watchrailContext, credentialId);
  }
}

function toResponse(record: {
  id: string;
  name: string | null;
  start: string | null;
  enabled: boolean | null;
  permissions: string | null;
  expiresAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: record.id,
    name: record.name,
    start: record.start,
    enabled: record.enabled,
    permissions: record.permissions ? (JSON.parse(record.permissions) as unknown) : [],
    expiresAt: record.expiresAt?.toISOString() ?? null,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}
