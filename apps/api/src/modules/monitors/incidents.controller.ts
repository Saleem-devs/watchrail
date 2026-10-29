import { Controller, Get, Inject, Query, Req } from '@nestjs/common';
import { RequirePermission } from '../../auth/auth.guard.js';
import { PERMISSIONS } from '../../auth/permissions.js';
import type { RequestWithContext } from '../../auth/request-context.js';
import { MonitorsService } from './monitors.service.js';
import { toOrganizationIncidentHistoryResponse } from './monitors.presenter.js';

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
}
