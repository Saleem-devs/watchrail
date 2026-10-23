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
import { RequirePermission } from '../../auth/auth.guard.js';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';
import { PERMISSIONS } from '../../auth/permissions.js';
import type { RequestWithContext } from '../../auth/request-context.js';
import { ApiCredentialsService } from './api-credentials.service.js';
import { presentApiCredential, presentCreatedApiCredential } from './api-credentials.presenter.js';
import {
  createApiCredentialSchema,
  type CreateApiCredentialInput,
} from './dto/create-api-credential.input.js';

@Controller('api-credentials')
export class ApiCredentialsController {
  constructor(@Inject(ApiCredentialsService) private readonly credentials: ApiCredentialsService) {}

  @Post()
  @RequirePermission(PERMISSIONS.API_KEY_MANAGE)
  async create(
    @Req() request: RequestWithContext,
    @Body(new ZodValidationPipe(createApiCredentialSchema, 'body'))
    input: CreateApiCredentialInput,
  ) {
    const created = await this.credentials.create(request.watchrailContext, input);
    return { data: presentCreatedApiCredential(created.record, created.token) };
  }

  @Get()
  @RequirePermission(PERMISSIONS.API_KEY_READ)
  async list(@Req() request: RequestWithContext) {
    return {
      data: (await this.credentials.list(request.watchrailContext)).map(presentApiCredential),
    };
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
