import { Controller, Get, Inject, Param, ParseUUIDPipe, Query, Req } from '@nestjs/common';
import { RequirePermission } from '../../auth.guard.js';
import { MonitorsService } from '../../monitors.service.js';
import { PERMISSIONS } from '../../permissions.js';
import type { RequestWithContext } from '../../request-context.js';

@Controller('monitors')
export class MonitorUptimeController {
  constructor(@Inject(MonitorsService) private readonly monitors: MonitorsService) {}

  @Get(':monitorId/uptime')
  @RequirePermission(PERMISSIONS.AVAILABILITY_READ)
  async getUptime(
    @Req() request: RequestWithContext,
    @Param('monitorId', new ParseUUIDPipe()) monitorId: string,
    @Query() query: Record<string, unknown>,
  ) {
    return { data: await this.monitors.uptime(request.watchrailContext, monitorId, query) };
  }

  @Get(':monitorId/uptime/daily')
  @RequirePermission(PERMISSIONS.AVAILABILITY_READ)
  async getDailyUptime(
    @Req() request: RequestWithContext,
    @Param('monitorId', new ParseUUIDPipe()) monitorId: string,
    @Query() query: Record<string, unknown>,
  ) {
    return { data: await this.monitors.dailyUptime(request.watchrailContext, monitorId, query) };
  }
}
