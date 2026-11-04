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
import { RequirePermission } from '../../auth/auth.guard.js';
import { PERMISSIONS } from '../../auth/permissions.js';
import type { RequestWithContext } from '../../auth/request-context.js';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';
import {
  createWorkspaceSecretSchema,
  listWorkspaceSecretsQuerySchema,
  rotateWorkspaceSecretSchema,
  updateWorkspaceSecretSchema,
  type CreateWorkspaceSecretInput,
  type ListWorkspaceSecretsQuery,
  type RotateWorkspaceSecretInput,
  type UpdateWorkspaceSecretInput,
} from './dto/workspace-secret-input.js';
import {
  presentWorkspaceSecret,
  presentWorkspaceSecretAuditEvent,
} from './workspace-secrets.presenter.js';
import { WorkspaceSecretsService } from './workspace-secrets.service.js';

@Controller('workspace-secrets')
export class WorkspaceSecretsController {
  constructor(@Inject(WorkspaceSecretsService) private readonly secrets: WorkspaceSecretsService) {}

  @Post()
  @RequirePermission(PERMISSIONS.SECRET_MANAGE)
  async create(
    @Req() request: RequestWithContext,
    @Body(new ZodValidationPipe(createWorkspaceSecretSchema, 'body'))
    input: CreateWorkspaceSecretInput,
  ) {
    return {
      data: presentWorkspaceSecret(await this.secrets.create(request.watchrailContext, input)),
    };
  }

  @Get()
  @RequirePermission(PERMISSIONS.SECRET_READ)
  async list(
    @Req() request: RequestWithContext,
    @Query(new ZodValidationPipe(listWorkspaceSecretsQuerySchema, 'query'))
    query: ListWorkspaceSecretsQuery,
  ) {
    return {
      data: (await this.secrets.list(request.watchrailContext, query)).map(presentWorkspaceSecret),
    };
  }

  @Get(':secretId')
  @RequirePermission(PERMISSIONS.SECRET_READ)
  async find(
    @Req() request: RequestWithContext,
    @Param('secretId', ParseUUIDPipe) secretId: string,
  ) {
    return {
      data: presentWorkspaceSecret(await this.secrets.find(request.watchrailContext, secretId)),
    };
  }

  @Get(':secretId/audit-events')
  @RequirePermission(PERMISSIONS.SECRET_READ)
  async listAuditEvents(
    @Req() request: RequestWithContext,
    @Param('secretId', ParseUUIDPipe) secretId: string,
  ) {
    return {
      data: (await this.secrets.listAuditEvents(request.watchrailContext, secretId)).map(
        presentWorkspaceSecretAuditEvent,
      ),
    };
  }

  @Patch(':secretId')
  @RequirePermission(PERMISSIONS.SECRET_MANAGE)
  async update(
    @Req() request: RequestWithContext,
    @Param('secretId', ParseUUIDPipe) secretId: string,
    @Body(new ZodValidationPipe(updateWorkspaceSecretSchema, 'body'))
    input: UpdateWorkspaceSecretInput,
  ) {
    return {
      data: presentWorkspaceSecret(
        await this.secrets.update(request.watchrailContext, secretId, input),
      ),
    };
  }

  @Post(':secretId/rotations')
  @RequirePermission(PERMISSIONS.SECRET_MANAGE)
  async rotate(
    @Req() request: RequestWithContext,
    @Param('secretId', ParseUUIDPipe) secretId: string,
    @Body(new ZodValidationPipe(rotateWorkspaceSecretSchema, 'body'))
    input: RotateWorkspaceSecretInput,
  ) {
    return {
      data: presentWorkspaceSecret(
        await this.secrets.rotate(request.watchrailContext, secretId, input),
      ),
    };
  }

  @Delete(':secretId')
  @RequirePermission(PERMISSIONS.SECRET_MANAGE)
  async archive(
    @Req() request: RequestWithContext,
    @Param('secretId', ParseUUIDPipe) secretId: string,
  ) {
    return {
      data: presentWorkspaceSecret(await this.secrets.archive(request.watchrailContext, secretId)),
    };
  }
}
