import { Body, Controller, Get, HttpCode, Inject, Param, Patch, Post, Req } from '@nestjs/common';
import type { CheckRoundRecord, ManualRoundResult, MonitorRecord } from '@watchrail/db';
import type { CreateMonitorCommand } from '@watchrail/domain';
import type { HttpStatusPolicy, StoredRequestHeader } from '@watchrail/domain';
import { MonitorsService } from './monitors.service.js';
import type { RequestWithContext } from './request-context.js';

interface MonitorResponse {
  id: string;
  name: string;
  url: string;
  method: string;
  lifecycleState: string;
  timeoutMs: number;
  statusPolicy: HttpStatusPolicy;
  requestHeaders: Array<{
    name: string;
    sensitive: boolean;
    value: string | null;
    hasValue: true;
  }>;
  locations: string[];
  createdAt: string;
  updatedAt: string;
}

interface ManualRoundResponse {
  id: string;
  monitorId: string;
  status: string;
  assignmentStatus: string;
  createdAt: string;
  result: {
    outcome: string;
    stage: string;
    reason: string;
    statusCode: number | null;
    responseTimeMs: number | null;
    attemptDurationMs: number;
    checkedAt: string;
  } | null;
}

@Controller('monitors')
export class MonitorsController {
  constructor(@Inject(MonitorsService) private readonly monitors: MonitorsService) {}

  @Post()
  async create(
    @Req() request: RequestWithContext,
    @Body() command: CreateMonitorCommand,
  ): Promise<{ data: MonitorResponse }> {
    const monitor = await this.monitors.create(request.watchrailContext, command);
    return { data: toResponse(monitor) };
  }

  @Get()
  async list(@Req() request: RequestWithContext): Promise<{ data: MonitorResponse[] }> {
    const monitors = await this.monitors.list(request.watchrailContext);
    return { data: monitors.map(toResponse) };
  }

  @Patch(':monitorId/status-policy')
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
    return { data: toResponse(monitor) };
  }

  @Patch(':monitorId/request-headers')
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
    return { data: toResponse(monitor) };
  }

  @Post(':monitorId/check-rounds')
  @HttpCode(202)
  async runNow(
    @Req() request: RequestWithContext,
    @Param('monitorId') monitorId: string,
  ): Promise<{ data: ManualRoundResponse }> {
    const round = await this.monitors.runNow(request.watchrailContext, monitorId);
    return { data: toPendingRoundResponse(round) };
  }

  @Get(':monitorId/check-rounds/:roundId')
  async getManualRound(
    @Req() request: RequestWithContext,
    @Param('monitorId') monitorId: string,
    @Param('roundId') roundId: string,
  ): Promise<{ data: ManualRoundResponse }> {
    const round = await this.monitors.getManualRound(request.watchrailContext, monitorId, roundId);
    return { data: toManualRoundResponse(round) };
  }
}

function toResponse(monitor: MonitorRecord): MonitorResponse {
  return {
    id: monitor.id,
    name: monitor.name,
    url: monitor.url,
    method: monitor.method,
    lifecycleState: monitor.lifecycleState,
    timeoutMs: monitor.timeoutMs,
    statusPolicy: monitor.statusPolicy,
    requestHeaders: redactRequestHeaders(monitor.requestHeaders),
    locations: monitor.locations,
    createdAt: monitor.createdAt.toISOString(),
    updatedAt: monitor.updatedAt.toISOString(),
  };
}

function redactRequestHeaders(
  headers: readonly StoredRequestHeader[],
): MonitorResponse['requestHeaders'] {
  return headers.map((header) => ({
    name: header.name,
    sensitive: header.sensitive,
    value: header.sensitive ? null : header.value,
    hasValue: true,
  }));
}

function toPendingRoundResponse(round: CheckRoundRecord): ManualRoundResponse {
  return {
    id: round.id,
    monitorId: round.monitorId,
    status: round.status,
    assignmentStatus: 'PENDING',
    createdAt: round.createdAt.toISOString(),
    result: null,
  };
}

function toManualRoundResponse(round: ManualRoundResult): ManualRoundResponse {
  return {
    id: round.id,
    monitorId: round.monitorId,
    status: round.status,
    assignmentStatus: round.assignmentStatus,
    createdAt: round.createdAt.toISOString(),
    result: round.result
      ? {
          ...round.result,
          checkedAt: round.result.checkedAt.toISOString(),
        }
      : null,
  };
}
