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
  Req,
} from '@nestjs/common';
import { RequirePermission } from '../../auth/auth.guard.js';
import { PERMISSIONS } from '../../auth/permissions.js';
import type { RequestWithContext } from '../../auth/request-context.js';
import {
  presentMaintenanceWindow,
  presentMaintenanceWindowAuditEvent,
} from './maintenance-windows.presenter.js';
import { MaintenanceWindowsService } from './maintenance-windows.service.js';

@Controller('projects/:projectId/maintenance-windows')
export class MaintenanceWindowsController {
  constructor(
    @Inject(MaintenanceWindowsService)
    private readonly windows: MaintenanceWindowsService,
  ) {}

  @Post()
  @RequirePermission(PERMISSIONS.MAINTENANCE_MANAGE)
  async create(
    @Req() request: RequestWithContext,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Body() input: unknown,
  ) {
    return {
      data: presentMaintenanceWindow(
        await this.windows.create(request.watchrailContext, projectId, input),
      ),
    };
  }

  @Get()
  @RequirePermission(PERMISSIONS.MAINTENANCE_READ)
  async list(
    @Req() request: RequestWithContext,
    @Param('projectId', ParseUUIDPipe) projectId: string,
  ) {
    return {
      data: (await this.windows.list(request.watchrailContext, projectId)).map(
        presentMaintenanceWindow,
      ),
    };
  }

  @Get(':maintenanceWindowId')
  @RequirePermission(PERMISSIONS.MAINTENANCE_READ)
  async find(
    @Req() request: RequestWithContext,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('maintenanceWindowId', ParseUUIDPipe) maintenanceWindowId: string,
  ) {
    return {
      data: presentMaintenanceWindow(
        await this.windows.find(request.watchrailContext, projectId, maintenanceWindowId),
      ),
    };
  }

  @Get(':maintenanceWindowId/audit-events')
  @RequirePermission(PERMISSIONS.MAINTENANCE_READ)
  async listAuditEvents(
    @Req() request: RequestWithContext,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('maintenanceWindowId', ParseUUIDPipe) maintenanceWindowId: string,
  ) {
    return {
      data: (
        await this.windows.listAuditHistory(
          request.watchrailContext,
          projectId,
          maintenanceWindowId,
        )
      ).map(presentMaintenanceWindowAuditEvent),
    };
  }

  @Patch(':maintenanceWindowId')
  @RequirePermission(PERMISSIONS.MAINTENANCE_MANAGE)
  async update(
    @Req() request: RequestWithContext,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('maintenanceWindowId', ParseUUIDPipe) maintenanceWindowId: string,
    @Body() input: unknown,
  ) {
    return {
      data: presentMaintenanceWindow(
        await this.windows.update(request.watchrailContext, projectId, maintenanceWindowId, input),
      ),
    };
  }

  @Delete(':maintenanceWindowId')
  @RequirePermission(PERMISSIONS.MAINTENANCE_MANAGE)
  async archive(
    @Req() request: RequestWithContext,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('maintenanceWindowId', ParseUUIDPipe) maintenanceWindowId: string,
  ) {
    return {
      data: presentMaintenanceWindow(
        await this.windows.archive(request.watchrailContext, projectId, maintenanceWindowId),
      ),
    };
  }
}
