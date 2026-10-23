import { Body, Controller, Get, Inject, Param, Patch, Post, Req } from '@nestjs/common';
import type { MonitorRecord } from '@watchrail/db';
import type { CreateMonitorCommand } from '@watchrail/domain';
import { MonitorsService } from './monitors.service.js';
import { RequirePermission } from '../../auth/auth.guard.js';
import { PERMISSIONS } from '../../auth/permissions.js';
import type { RequestWithContext } from '../../auth/request-context.js';
import { type MonitorResponse, toResponse } from './monitors.presenter.js';

@Controller('monitors')
export class MonitorsController {
  constructor(@Inject(MonitorsService) private readonly monitors: MonitorsService) {}

  @Post()
  @RequirePermission(PERMISSIONS.MONITOR_CREATE)
  async create(
    @Req() request: RequestWithContext,
    @Body() command: CreateMonitorCommand,
  ): Promise<{ data: MonitorResponse }> {
    const monitor = await this.monitors.create(request.watchrailContext, command);
    return { data: await this.toMonitorResponse(request, monitor) };
  }

  @Get()
  @RequirePermission(PERMISSIONS.MONITOR_READ)
  async list(@Req() request: RequestWithContext): Promise<{ data: MonitorResponse[] }> {
    const monitors = await this.monitors.list(request.watchrailContext);
    return {
      data: monitors.map(({ monitor, currentCheck, incidentState, uptime }) =>
        toResponse(monitor, currentCheck, incidentState, uptime),
      ),
    };
  }

  @Patch(':monitorId/status-policy')
  @RequirePermission(PERMISSIONS.MONITOR_UPDATE)
  async updateStatusPolicy(
    @Req() request: RequestWithContext,
    @Param('monitorId') monitorId: string,
    @Body() body: { statusPolicy?: unknown },
  ): Promise<{ data: MonitorResponse }> {
    const monitor = await this.monitors.updateStatusPolicy(
      request.watchrailContext,
      monitorId,
      body.statusPolicy,
    );
    return { data: await this.toMonitorResponse(request, monitor) };
  }

  @Patch(':monitorId/http-settings')
  @RequirePermission(PERMISSIONS.MONITOR_UPDATE)
  async updateHttpSettings(
    @Req() request: RequestWithContext,
    @Param('monitorId') monitorId: string,
    @Body() body: unknown,
  ): Promise<{ data: MonitorResponse }> {
    const monitor = await this.monitors.updateHttpSettings(
      request.watchrailContext,
      monitorId,
      body,
    );
    return { data: await this.toMonitorResponse(request, monitor) };
  }

  @Patch(':monitorId/request-headers')
  @RequirePermission(PERMISSIONS.MONITOR_UPDATE)
  async updateRequestHeaders(
    @Req() request: RequestWithContext,
    @Param('monitorId') monitorId: string,
    @Body() body: { requestHeaders?: unknown },
  ): Promise<{ data: MonitorResponse }> {
    const monitor = await this.monitors.updateRequestHeaders(
      request.watchrailContext,
      monitorId,
      body.requestHeaders,
    );
    return { data: await this.toMonitorResponse(request, monitor) };
  }

  @Patch(':monitorId/schedule-settings')
  @RequirePermission(PERMISSIONS.MONITOR_UPDATE)
  async updateScheduleSettings(
    @Req() request: RequestWithContext,
    @Param('monitorId') monitorId: string,
    @Body() body: unknown,
  ): Promise<{ data: MonitorResponse }> {
    const monitor = await this.monitors.updateScheduleSettings(
      request.watchrailContext,
      monitorId,
      body,
    );
    return { data: await this.toMonitorResponse(request, monitor) };
  }

  @Patch(':monitorId/lifecycle')
  @RequirePermission(PERMISSIONS.MONITOR_UPDATE)
  async updateLifecycle(
    @Req() request: RequestWithContext,
    @Param('monitorId') monitorId: string,
    @Body() body: unknown,
  ): Promise<{ data: MonitorResponse }> {
    const monitor = await this.monitors.updateLifecycle(request.watchrailContext, monitorId, body);
    return { data: await this.toMonitorResponse(request, monitor) };
  }

  @Patch(':monitorId/locations')
  @RequirePermission(PERMISSIONS.MONITOR_UPDATE)
  async updateLocations(
    @Req() request: RequestWithContext,
    @Param('monitorId') monitorId: string,
    @Body() body: unknown,
  ): Promise<{ data: MonitorResponse }> {
    const monitor = await this.monitors.updateLocations(request.watchrailContext, monitorId, body);
    return { data: await this.toMonitorResponse(request, monitor) };
  }

  @Patch(':monitorId/assertions')
  @RequirePermission(PERMISSIONS.MONITOR_UPDATE)
  async updateAssertions(
    @Req() request: RequestWithContext,
    @Param('monitorId') monitorId: string,
    @Body() body: unknown,
  ): Promise<{ data: MonitorResponse }> {
    const monitor = await this.monitors.updateAssertions(request.watchrailContext, monitorId, body);
    return { data: await this.toMonitorResponse(request, monitor) };
  }

  private async toMonitorResponse(
    request: RequestWithContext,
    monitor: MonitorRecord,
  ): Promise<MonitorResponse> {
    const [currentCheck, incidentState, uptime] = await Promise.all([
      this.monitors.currentCheck(request.watchrailContext, monitor.id),
      this.monitors.currentIncidentState(request.watchrailContext, monitor.id),
      this.monitors.uptime(request.watchrailContext, monitor.id, {}),
    ]);
    return toResponse(monitor, currentCheck, incidentState, uptime);
  }
}
