import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import type { MonitorRecord } from '@watchrail/db';
import type { CreateMonitorCommand } from '@watchrail/domain';
import { MonitorsService } from '../../monitors.service.js';
import type { RequestWithContext } from '../../request-context.js';
import { RequirePermission } from '../../auth.guard.js';
import { PERMISSIONS } from '../../permissions.js';
import {
  type CheckRoundResponse,
  type MonitorResponse,
  toResponse,
  toPendingRoundResponse,
  toCheckRoundResponse,
  toHistoryListItem,
  toIncidentHistoryResponse,
  toIncidentDetailResponse,
} from './monitors.presenter.js';

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

  @Post(':monitorId/check-rounds')
  @RequirePermission(PERMISSIONS.MONITOR_EXECUTE)
  @HttpCode(202)
  async runNow(
    @Req() request: RequestWithContext,
    @Param('monitorId') monitorId: string,
  ): Promise<{ data: CheckRoundResponse }> {
    const round = await this.monitors.runNow(request.watchrailContext, monitorId);
    return { data: toPendingRoundResponse(round) };
  }

  @Get(':monitorId/check-rounds')
  @RequirePermission(PERMISSIONS.CHECK_READ)
  async listCheckHistory(
    @Req() request: RequestWithContext,
    @Param('monitorId') monitorId: string,
    @Query() query: Record<string, unknown>,
  ): Promise<{
    data: ReturnType<typeof toHistoryListItem>[];
    page: { nextCursor: string | null };
  }> {
    const history = await this.monitors.listCheckHistory(
      request.watchrailContext,
      monitorId,
      query,
    );
    return {
      data: history.items.map(toHistoryListItem),
      page: { nextCursor: history.nextCursor },
    };
  }

  @Get(':monitorId/check-rounds/:roundId')
  @RequirePermission(PERMISSIONS.CHECK_READ)
  async getCheckRound(
    @Req() request: RequestWithContext,
    @Param('monitorId') monitorId: string,
    @Param('roundId') roundId: string,
  ): Promise<{ data: CheckRoundResponse }> {
    const round = await this.monitors.getCheckRound(request.watchrailContext, monitorId, roundId);
    return { data: toCheckRoundResponse(round) };
  }

  @Get(':monitorId/incidents')
  @RequirePermission(PERMISSIONS.INCIDENT_READ)
  async listIncidents(
    @Req() request: RequestWithContext,
    @Param('monitorId') monitorId: string,
    @Query() query: Record<string, unknown>,
  ) {
    const page = await this.monitors.listIncidentHistory(
      request.watchrailContext,
      monitorId,
      query,
    );
    return {
      data: page.items.map(toIncidentHistoryResponse),
      page: { nextCursor: page.nextCursor },
    };
  }

  @Get(':monitorId/incidents/:incidentId')
  @RequirePermission(PERMISSIONS.INCIDENT_READ)
  async getIncident(
    @Req() request: RequestWithContext,
    @Param('monitorId') monitorId: string,
    @Param('incidentId') incidentId: string,
  ) {
    return {
      data: toIncidentDetailResponse(
        await this.monitors.getIncident(request.watchrailContext, monitorId, incidentId),
      ),
    };
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

