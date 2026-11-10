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
  StatusPageIncidentRepository,
  StatusPageIncidentComponentSelectionError,
  StatusPageIncidentNotFoundError,
  StatusPageIncidentTransitionError,
  type StatusPageIncidentRecord,
  StatusPageSlugTakenError,
  type StatusPageRecord,
} from '@watchrail/db';
import { StatusPageIncidentInputError, StatusPageInputError } from '@watchrail/domain';
import type { RequestContext } from '../../auth/request-context.js';
import type {
  CreateStatusPageInput,
  ReplaceStatusPageComponentsInput,
  SetStatusPagePublicationInput,
  UpdateStatusPageSettingsInput,
  CreateStatusPageIncidentInput,
  UpdateStatusPageIncidentInput,
} from './dto/status-page-input.js';

@Injectable()
export class StatusPagesService {
  constructor(
    @Inject(StatusPageRepository)
    private readonly pages: StatusPageRepository,
    @Inject(StatusPageIncidentRepository)
    private readonly incidents: StatusPageIncidentRepository,
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

  listIncidents(
    context: RequestContext,
    statusPageId: string,
  ): Promise<StatusPageIncidentRecord[]> {
    return this.incidents.list(context.organizationId, statusPageId);
  }

  async findIncident(
    context: RequestContext,
    statusPageId: string,
    incidentId: string,
  ): Promise<StatusPageIncidentRecord> {
    const incident = await this.incidents.find(context.organizationId, statusPageId, incidentId);
    if (!incident) this.incidentNotFound();
    return incident;
  }

  async createIncident(
    context: RequestContext,
    statusPageId: string,
    input: CreateStatusPageIncidentInput,
  ): Promise<StatusPageIncidentRecord> {
    return this.runIncident(() =>
      this.incidents.create(context.organizationId, statusPageId, context.actorId, input),
    );
  }

  async updateIncident(
    context: RequestContext,
    statusPageId: string,
    incidentId: string,
    input: UpdateStatusPageIncidentInput,
  ): Promise<StatusPageIncidentRecord> {
    return this.runIncident(() =>
      this.incidents.appendUpdate(
        context.organizationId,
        statusPageId,
        incidentId,
        context.actorId,
        input,
      ),
    );
  }

  private async runIncident(
    operation: () => Promise<StatusPageIncidentRecord>,
  ): Promise<StatusPageIncidentRecord> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof StatusPageIncidentNotFoundError) this.incidentNotFound();
      if (error instanceof StatusPageIncidentComponentSelectionError) {
        throw new BadRequestException({
          code: 'VALIDATION_FAILED',
          message: error.message,
          fields: { componentIds: [error.message] },
        });
      }
      if (error instanceof StatusPageIncidentTransitionError) {
        throw new ConflictException({
          code: 'STATUS_PAGE_INCIDENT_TRANSITION_INVALID',
          message: error.message,
        });
      }
      if (error instanceof StatusPageIncidentInputError) {
        throw new BadRequestException({
          code: 'VALIDATION_FAILED',
          message: error.message,
          fields: { incident: error.issues },
        });
      }
      throw error;
    }
  }

  private incidentNotFound(): never {
    throw new NotFoundException({
      code: 'STATUS_PAGE_INCIDENT_NOT_FOUND',
      message: 'Status page incident not found.',
    });
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
