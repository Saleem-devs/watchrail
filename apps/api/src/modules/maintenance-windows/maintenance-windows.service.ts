import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import {
  MaintenanceWindowNotFoundError,
  MaintenanceWindowProjectNotFoundError,
  MaintenanceWindowRepository,
  MaintenanceWindowTargetError,
  type MaintenanceWindowAuditRecord,
  type MaintenanceWindowRecord,
} from '@watchrail/db';
import { MaintenanceWindowInputError } from '@watchrail/domain';
import type { RequestContext } from '../../auth/request-context.js';

@Injectable()
export class MaintenanceWindowsService {
  constructor(
    @Inject(MaintenanceWindowRepository)
    private readonly windows: MaintenanceWindowRepository,
  ) {}

  async create(
    context: RequestContext,
    projectId: string,
    input: unknown,
  ): Promise<MaintenanceWindowRecord> {
    try {
      return await this.windows.create(context.organizationId, projectId, context.actorId, input);
    } catch (error) {
      this.translate(error);
    }
  }

  list(context: RequestContext, projectId: string): Promise<MaintenanceWindowRecord[]> {
    return this.windows.listForProject(context.organizationId, projectId);
  }

  async find(
    context: RequestContext,
    projectId: string,
    maintenanceWindowId: string,
  ): Promise<MaintenanceWindowRecord> {
    const window = await this.windows.findForProject(
      context.organizationId,
      projectId,
      maintenanceWindowId,
    );
    if (!window) this.notFound();
    return window;
  }

  async update(
    context: RequestContext,
    projectId: string,
    maintenanceWindowId: string,
    input: unknown,
  ): Promise<MaintenanceWindowRecord> {
    try {
      return await this.windows.update(
        context.organizationId,
        projectId,
        maintenanceWindowId,
        context.actorId,
        input,
      );
    } catch (error) {
      this.translate(error);
    }
  }

  async archive(
    context: RequestContext,
    projectId: string,
    maintenanceWindowId: string,
  ): Promise<MaintenanceWindowRecord> {
    try {
      return await this.windows.archive(
        context.organizationId,
        projectId,
        maintenanceWindowId,
        context.actorId,
      );
    } catch (error) {
      this.translate(error);
    }
  }

  async listAuditHistory(
    context: RequestContext,
    projectId: string,
    maintenanceWindowId: string,
  ): Promise<MaintenanceWindowAuditRecord[]> {
    try {
      return await this.windows.listAuditHistory(
        context.organizationId,
        projectId,
        maintenanceWindowId,
      );
    } catch (error) {
      this.translate(error);
    }
  }

  private translate(error: unknown): never {
    if (
      error instanceof MaintenanceWindowNotFoundError ||
      error instanceof MaintenanceWindowProjectNotFoundError
    ) {
      this.notFound();
    }
    if (error instanceof MaintenanceWindowInputError) {
      throw new BadRequestException({
        code: 'VALIDATION_FAILED',
        message: error.message,
        fields: error.fields,
      });
    }
    if (error instanceof MaintenanceWindowTargetError) {
      throw new BadRequestException({
        code: 'VALIDATION_FAILED',
        message: error.message,
        fields: { monitorIds: ['Choose monitors from this project.'] },
      });
    }
    throw error;
  }

  private notFound(): never {
    throw new NotFoundException({
      code: 'MAINTENANCE_WINDOW_NOT_FOUND',
      message: 'Maintenance window not found.',
    });
  }
}
