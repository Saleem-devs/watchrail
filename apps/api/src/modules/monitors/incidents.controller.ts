import { Body, Controller, Delete, Get, Inject, Param, Post, Query, Req } from '@nestjs/common';
import { RequirePermission } from '../../auth/auth.guard.js';
import { PERMISSIONS } from '../../auth/permissions.js';
import type { RequestWithContext } from '../../auth/request-context.js';
import { MonitorsService } from './monitors.service.js';
import {
  toIncidentActionEventResponse,
  toIncidentDetailResponse,
  toOrganizationIncidentDetailResponse,
  toOrganizationIncidentHistoryResponse,
} from './monitors.presenter.js';

@Controller('incidents')
export class IncidentsController {
  constructor(@Inject(MonitorsService) private readonly monitors: MonitorsService) {}

  @Get()
  @RequirePermission(PERMISSIONS.INCIDENT_READ)
  async list(@Req() request: RequestWithContext, @Query() query: Record<string, unknown>) {
    const page = await this.monitors.listOrganizationIncidentHistory(
      request.watchrailContext,
      query,
    );
    return {
      data: page.items.map(toOrganizationIncidentHistoryResponse),
      page: {
        number: page.page,
        limit: page.limit,
        total: page.total,
        totalPages: page.totalPages,
      },
    };
  }

  @Get(':incidentId')
  @RequirePermission(PERMISSIONS.INCIDENT_READ)
  async get(@Req() request: RequestWithContext, @Param('incidentId') incidentId: string) {
    return {
      data: toOrganizationIncidentDetailResponse(
        await this.monitors.getOrganizationIncident(request.watchrailContext, incidentId),
      ),
    };
  }

  @Get(':incidentId/audit-events')
  @RequirePermission(PERMISSIONS.INCIDENT_READ)
  async listAuditEvents(
    @Req() request: RequestWithContext,
    @Param('incidentId') incidentId: string,
  ) {
    return {
      data: (
        await this.monitors.listIncidentActionEvents(request.watchrailContext, incidentId)
      ).map(toIncidentActionEventResponse),
    };
  }

  @Post(':incidentId/acknowledge')
  @RequirePermission(PERMISSIONS.INCIDENT_MANAGE)
  async acknowledge(@Req() request: RequestWithContext, @Param('incidentId') incidentId: string) {
    return {
      data: toIncidentDetailResponse(
        await this.monitors.acknowledgeIncident(request.watchrailContext, incidentId),
      ),
    };
  }

  @Post(':incidentId/silence')
  @RequirePermission(PERMISSIONS.INCIDENT_MANAGE)
  async silence(
    @Req() request: RequestWithContext,
    @Param('incidentId') incidentId: string,
    @Body() body: unknown,
  ) {
    return {
      data: toIncidentDetailResponse(
        await this.monitors.silenceIncident(request.watchrailContext, incidentId, body),
      ),
    };
  }

  @Delete(':incidentId/silence')
  @RequirePermission(PERMISSIONS.INCIDENT_MANAGE)
  async unsilence(@Req() request: RequestWithContext, @Param('incidentId') incidentId: string) {
    return {
      data: toIncidentDetailResponse(
        await this.monitors.unsilenceIncident(request.watchrailContext, incidentId),
      ),
    };
  }

  @Post(':incidentId/resolve')
  @RequirePermission(PERMISSIONS.INCIDENT_MANAGE)
  async resolve(
    @Req() request: RequestWithContext,
    @Param('incidentId') incidentId: string,
    @Body() body: unknown,
  ) {
    return {
      data: toIncidentDetailResponse(
        await this.monitors.resolveIncident(request.watchrailContext, incidentId, body),
      ),
    };
  }
}
