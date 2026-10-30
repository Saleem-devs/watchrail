import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ProjectRepository, type ProjectListItem, type ProjectRecord } from '@watchrail/db';
import { parseNewProject, ProjectInputError } from '@watchrail/domain';
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
}

function isUniqueViolation(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const value = error as { code?: unknown; cause?: unknown };
  return value.code === '23505' || (value.cause !== undefined && isUniqueViolation(value.cause));
}
