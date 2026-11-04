import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  WorkspaceSecretConflictError,
  WorkspaceSecretInputError as WorkspaceSecretRepositoryInputError,
  WorkspaceSecretNotFoundError,
  WorkspaceSecretRepository,
  type WorkspaceSecretAuditRecord,
  type WorkspaceSecretRecord,
} from '@watchrail/db';
import {
  encryptWorkspaceSecret,
  WorkspaceSecretInputError,
} from '@watchrail/secret-vault-security';
import type { RequestContext } from '../../auth/request-context.js';
import { APP_CONFIG, type AppConfig } from '../../config/config.js';
import type {
  CreateWorkspaceSecretInput,
  ListWorkspaceSecretsQuery,
  RotateWorkspaceSecretInput,
  UpdateWorkspaceSecretInput,
} from './dto/workspace-secret-input.js';

@Injectable()
export class WorkspaceSecretsService {
  constructor(
    @Inject(WorkspaceSecretRepository)
    private readonly secrets: WorkspaceSecretRepository,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async create(
    context: RequestContext,
    input: CreateWorkspaceSecretInput,
  ): Promise<WorkspaceSecretRecord> {
    try {
      return await this.secrets.create(
        context.organizationId,
        context.actorId,
        {
          key: input.key,
          ...(input.description === undefined ? {} : { description: input.description }),
        },
        ({ secretId, versionNumber }) =>
          encryptWorkspaceSecret(
            input.value,
            { organizationId: context.organizationId, secretId, versionNumber },
            this.config.workspaceSecretKeyring,
          ),
      );
    } catch (error) {
      this.translate(error);
    }
  }

  list(
    context: RequestContext,
    query: ListWorkspaceSecretsQuery,
  ): Promise<WorkspaceSecretRecord[]> {
    return this.secrets.listForOrganization(context.organizationId, {
      includeArchived: query.includeArchived === 'true',
    });
  }

  async find(context: RequestContext, secretId: string): Promise<WorkspaceSecretRecord> {
    const secret = await this.secrets.findForOrganization(context.organizationId, secretId);
    if (!secret) this.notFound();
    return secret;
  }

  async update(
    context: RequestContext,
    secretId: string,
    input: UpdateWorkspaceSecretInput,
  ): Promise<WorkspaceSecretRecord> {
    try {
      return await this.secrets.updateDescription(
        context.organizationId,
        secretId,
        context.actorId,
        input.description,
      );
    } catch (error) {
      this.translate(error);
    }
  }

  async rotate(
    context: RequestContext,
    secretId: string,
    input: RotateWorkspaceSecretInput,
  ): Promise<WorkspaceSecretRecord> {
    try {
      return await this.secrets.rotate(
        context.organizationId,
        secretId,
        context.actorId,
        ({ versionNumber }) =>
          encryptWorkspaceSecret(
            input.value,
            { organizationId: context.organizationId, secretId, versionNumber },
            this.config.workspaceSecretKeyring,
          ),
      );
    } catch (error) {
      this.translate(error);
    }
  }

  async archive(context: RequestContext, secretId: string): Promise<WorkspaceSecretRecord> {
    try {
      return await this.secrets.archive(context.organizationId, secretId, context.actorId);
    } catch (error) {
      this.translate(error);
    }
  }

  async listAuditEvents(
    context: RequestContext,
    secretId: string,
  ): Promise<WorkspaceSecretAuditRecord[]> {
    try {
      return await this.secrets.listAuditEvents(context.organizationId, secretId);
    } catch (error) {
      this.translate(error);
    }
  }

  private translate(error: unknown): never {
    if (error instanceof WorkspaceSecretNotFoundError) this.notFound();
    if (error instanceof WorkspaceSecretRepositoryInputError) {
      throw new BadRequestException({
        code: 'VALIDATION_FAILED',
        message: error.message,
        fields: error.fields,
      });
    }
    if (error instanceof WorkspaceSecretInputError) {
      throw new BadRequestException({
        code: 'VALIDATION_FAILED',
        message: 'Workspace secret settings are invalid.',
        fields: { value: [error.message] },
      });
    }
    if (error instanceof WorkspaceSecretConflictError || isUniqueViolation(error)) {
      const code = error instanceof WorkspaceSecretConflictError ? error.code : 'KEY_EXISTS';
      throw new ConflictException({
        code: `WORKSPACE_SECRET_${code}`,
        message:
          error instanceof WorkspaceSecretConflictError
            ? error.message
            : 'A workspace secret with this key already exists.',
      });
    }
    throw error;
  }

  private notFound(): never {
    throw new NotFoundException({
      code: 'WORKSPACE_SECRET_NOT_FOUND',
      message: 'Workspace secret not found.',
    });
  }
}

function isUniqueViolation(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as { code?: unknown; cause?: unknown };
  return candidate.code === '23505' || isUniqueViolation(candidate.cause);
}
