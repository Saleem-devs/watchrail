import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  StatusPageMonitorSelectionError,
  StatusPageNotFoundError,
  StatusPageRepository,
  StatusPageSlugTakenError,
  type StatusPageRecord,
} from '@watchrail/db';
import { StatusPageInputError } from '@watchrail/domain';
import type { RequestContext } from '../../auth/request-context.js';
import type {
  CreateStatusPageInput,
  ReplaceStatusPageComponentsInput,
  SetStatusPagePublicationInput,
  UpdateStatusPageSettingsInput,
} from './dto/status-page-input.js';

@Injectable()
export class StatusPagesService {
  constructor(
    @Inject(StatusPageRepository)
    private readonly pages: StatusPageRepository,
  ) {}

  async create(
    context: RequestContext,
    projectId: string,
    input: CreateStatusPageInput,
  ): Promise<StatusPageRecord> {
    return this.run(() =>
      this.pages.create(context.organizationId, {
        name: input.name,
        ...(input.logoUrl === undefined ? {} : { logoUrl: input.logoUrl }),
        slug: input.slug,
        projectId,
        components: input.components,
        ...(input.published === undefined ? {} : { published: input.published }),
      }),
    );
  }

  list(context: RequestContext, projectId: string): Promise<StatusPageRecord[]> {
    return this.pages.listForProject(context.organizationId, projectId);
  }

  async find(context: RequestContext, statusPageId: string): Promise<StatusPageRecord> {
    const page = await this.pages.findForOrganization(context.organizationId, statusPageId);
    if (!page) this.notFound();
    return page;
  }

  async updateSettings(
    context: RequestContext,
    statusPageId: string,
    input: UpdateStatusPageSettingsInput,
  ): Promise<StatusPageRecord> {
    return this.run(() => this.pages.updateSettings(context.organizationId, statusPageId, input));
  }

  async replaceComponents(
    context: RequestContext,
    statusPageId: string,
    input: ReplaceStatusPageComponentsInput,
  ): Promise<StatusPageRecord> {
    return this.run(() =>
      this.pages.replaceComponents(context.organizationId, statusPageId, input.components),
    );
  }

  async setPublished(
    context: RequestContext,
    statusPageId: string,
    input: SetStatusPagePublicationInput,
  ): Promise<StatusPageRecord> {
    return this.run(() =>
      this.pages.setPublished(context.organizationId, statusPageId, input.published),
    );
  }

  private async run(operation: () => Promise<StatusPageRecord>): Promise<StatusPageRecord> {
    try {
      return await operation();
    } catch (error) {
      this.translate(error);
    }
  }

  private translate(error: unknown): never {
    if (error instanceof StatusPageNotFoundError) this.notFound();
    if (error instanceof StatusPageSlugTakenError) {
      throw new ConflictException({
        code: 'STATUS_PAGE_SLUG_TAKEN',
        message: error.message,
      });
    }
    if (error instanceof StatusPageInputError) {
      throw new BadRequestException({
        code: 'VALIDATION_FAILED',
        message: error.message,
        fields: { statusPage: error.issues },
      });
    }
    if (error instanceof StatusPageMonitorSelectionError) {
      throw new BadRequestException({
        code: 'VALIDATION_FAILED',
        message: 'Status page component selection is invalid.',
        fields: { components: [error.message] },
      });
    }
    throw error;
  }

  private notFound(): never {
    throw new NotFoundException({
      code: 'STATUS_PAGE_NOT_FOUND',
      message: 'Status page not found.',
    });
  }
}
