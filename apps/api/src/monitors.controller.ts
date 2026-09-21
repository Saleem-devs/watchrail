import { Body, Controller, Get, Inject, Post, Req } from '@nestjs/common';
import type { MonitorRecord } from '@watchrail/db';
import type { CreateMonitorCommand } from '@watchrail/domain';
import { MonitorsService } from './monitors.service.js';
import type { RequestWithContext } from './request-context.js';

interface MonitorResponse {
  id: string;
  name: string;
  url: string;
  method: string;
  lifecycleState: string;
  timeoutMs: number;
  locations: string[];
  createdAt: string;
  updatedAt: string;
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
}

function toResponse(monitor: MonitorRecord): MonitorResponse {
  return {
    id: monitor.id,
    name: monitor.name,
    url: monitor.url,
    method: monitor.method,
    lifecycleState: monitor.lifecycleState,
    timeoutMs: monitor.timeoutMs,
    locations: monitor.locations,
    createdAt: monitor.createdAt.toISOString(),
    updatedAt: monitor.updatedAt.toISOString(),
  };
}
