import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  IncidentEscalationChannelError,
  ProjectRepository,
  type ProjectListItem,
  type ProjectRecord,
} from '@watchrail/db';
import { parseNewProject, ProjectInputError } from '@watchrail/domain';
import {
  IncidentEscalationPolicyInputError,
  parseIncidentEscalationPolicy,
  type IncidentEscalationPolicy,
} from '@watchrail/domain';
import type { RequestContext } from '../../auth/request-context.js';

@Injectable()
export class ProjectsService {
  constructor(@Inject(ProjectRepository) private readonly projects: ProjectRepository) {}

  async create(context: RequestContext, input: unknown): Promise<ProjectRecord> {
    try {
      return await this.projects.create(context.organizationId, parseNewProject(input));
    } catch (error) {
      if (error instanceof ProjectInputError) {
        throw new BadRequestException({
          code: 'VALIDATION_FAILED',
          message: error.message,
          fields: error.fields,
        });
      }
      if (isUniqueViolation(error)) {
        throw new ConflictException({
          code: 'PROJECT_SLUG_TAKEN',
          message: 'That project URL is already in use.',
        });
      }
      throw error;
    }
  }

  list(context: RequestContext): Promise<ProjectListItem[]> {
    return this.projects.listForOrganization(context.organizationId);
  }

  async find(context: RequestContext, projectId: string): Promise<ProjectRecord> {
    const project = await this.projects.findForOrganization(context.organizationId, projectId);
    if (!project) {
      throw new NotFoundException({
        code: 'PROJECT_NOT_FOUND',
        message: 'Project not found.',
      });
    }
    return project;
  }

  async getIncidentEscalationPolicy(
    context: RequestContext,
    projectId: string,
  ): Promise<IncidentEscalationPolicy> {
    const policy = await this.projects.getIncidentEscalationPolicy(
      context.organizationId,
      projectId,
    );
    if (!policy) this.projectNotFound();
    return policy;
  }

  async updateIncidentEscalationPolicy(
    context: RequestContext,
    projectId: string,
    input: unknown,
  ): Promise<IncidentEscalationPolicy> {
    try {
      const updated = await this.projects.updateIncidentEscalationPolicy(
        context.organizationId,
        projectId,
        parseIncidentEscalationPolicy(input),
      );
      if (!updated) this.projectNotFound();
      return updated;
    } catch (error) {
      if (error instanceof IncidentEscalationPolicyInputError) {
        throw new BadRequestException({
          code: 'VALIDATION_FAILED',
          message: error.message,
          fields: error.fields,
        });
      }
      if (error instanceof IncidentEscalationChannelError) {
        throw new BadRequestException({
          code: 'ESCALATION_CHANNEL_UNAVAILABLE',
          message: error.message,
          fields: { steps: ['Choose configured incident channels from this project.'] },
        });
      }
      throw error;
    }
  }

  private projectNotFound(): never {
    throw new NotFoundException({
      code: 'PROJECT_NOT_FOUND',
      message: 'Project not found.',
    });
  }
}

function isUniqueViolation(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const value = error as { code?: unknown; cause?: unknown };
  return value.code === '23505' || (value.cause !== undefined && isUniqueViolation(value.cause));
}
