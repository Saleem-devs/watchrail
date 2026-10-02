import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import type {
  CheckHistoryDetail,
  CheckHistoryListItem,
  CheckRoundRecord,
  CurrentCheck,
  MonitorRecord,
} from '@watchrail/db';
import type { CreateMonitorCommand } from '@watchrail/domain';
import {
  parseStoredRequestHeaders,
  parseStoredAssertionConfiguration,
  type HttpRedirectHop,
  type HttpStatusPolicy,
  type AssertionEvaluationV1,
} from '@watchrail/domain';
import { MonitorsService } from './monitors.service.js';
import type { RequestWithContext } from './request-context.js';

interface MonitorResponse {
  id: string;
  name: string;
  url: string;
  method: string;
  lifecycleState: string;
  timeoutMs: number;
  intervalSeconds: number;
  nextCheckAt: string | null;
  followRedirects: boolean;
  statusPolicy: HttpStatusPolicy;
  requestHeaders: Array<{
    name: string;
    sensitive: boolean;
    value: string | null;
    hasValue: true;
  }>;
  assertions: unknown;
  locations: string[];
  createdAt: string;
  updatedAt: string;
  currentCheck: {
    availability: CurrentCheck['availability'];
    responseTimeMs: number | null;
    checkedAt: string;
    roundId: string;
    trigger: CurrentCheck['trigger'];
  } | null;
}

interface CheckRoundResponse {
  id: string;
  monitorId: string;
  trigger: 'MANUAL' | 'SCHEDULED';
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
    redirects: HttpRedirectHop[];
    assertionEvaluation: AssertionEvaluationV1;
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
    return {
      data: monitors.map(({ monitor, currentCheck }) => toResponse(monitor, currentCheck)),
    };
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

  @Patch(':monitorId/http-settings')
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

  @Patch(':monitorId/schedule-settings')
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
    return { data: toResponse(monitor) };
  }

  @Patch(':monitorId/lifecycle')
  async updateLifecycle(
    @Req() request: RequestWithContext,
    @Param('monitorId') monitorId: string,
    @Body() body: unknown,
  ): Promise<{ data: MonitorResponse }> {
    const monitor = await this.monitors.updateLifecycle(request.watchrailContext, monitorId, body);
    return { data: toResponse(monitor) };
  }

  @Patch(':monitorId/assertions')
  async updateAssertions(
    @Req() request: RequestWithContext,
    @Param('monitorId') monitorId: string,
    @Body() body: unknown,
  ): Promise<{ data: MonitorResponse }> {
    const monitor = await this.monitors.updateAssertions(request.watchrailContext, monitorId, body);
    return { data: toResponse(monitor) };
  }

  @Post(':monitorId/check-rounds')
  @HttpCode(202)
  async runNow(
    @Req() request: RequestWithContext,
    @Param('monitorId') monitorId: string,
  ): Promise<{ data: CheckRoundResponse }> {
    const round = await this.monitors.runNow(request.watchrailContext, monitorId);
    return { data: toPendingRoundResponse(round) };
  }

  @Get(':monitorId/check-rounds')
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
  async getCheckRound(
    @Req() request: RequestWithContext,
    @Param('monitorId') monitorId: string,
    @Param('roundId') roundId: string,
  ): Promise<{ data: CheckRoundResponse }> {
    const round = await this.monitors.getCheckRound(request.watchrailContext, monitorId, roundId);
    return { data: toCheckRoundResponse(round) };
  }
}

function toResponse(
  monitor: MonitorRecord,
  currentCheck: CurrentCheck | null = null,
): MonitorResponse {
  return {
    id: monitor.id,
    name: monitor.name,
    url: monitor.url,
    method: monitor.method,
    lifecycleState: monitor.lifecycleState,
    timeoutMs: monitor.timeoutMs,
    intervalSeconds: monitor.intervalSeconds,
    nextCheckAt: monitor.nextCheckAt?.toISOString() ?? null,
    followRedirects: monitor.followRedirects,
    statusPolicy: monitor.statusPolicy,
    requestHeaders: redactRequestHeaders(monitor.requestHeaders),
    assertions: redactAssertions(monitor.assertions),
    locations: monitor.locations,
    createdAt: monitor.createdAt.toISOString(),
    updatedAt: monitor.updatedAt.toISOString(),
    currentCheck: currentCheck
      ? { ...currentCheck, checkedAt: currentCheck.checkedAt.toISOString() }
      : null,
  };
}

function redactRequestHeaders(value: unknown): MonitorResponse['requestHeaders'] {
  return parseStoredRequestHeaders(value).map((header) => ({
    name: header.name,
    sensitive: header.sensitive,
    value: header.sensitive ? null : header.value,
    hasValue: true,
  }));
}

function redactAssertions(value: unknown): unknown {
  const configuration = parseStoredAssertionConfiguration(value);
  const redactTarget = (target: unknown) => {
    if (
      typeof target === 'object' &&
      target !== null &&
      'sensitive' in target &&
      target.sensitive === true
    ) {
      return { sensitive: true, hasValue: true };
    }
    return target;
  };
  return {
    contractVersion: 1,
    assertions: {
      headers: configuration.assertions.headers.map((assertion) =>
        'target' in assertion
          ? { ...assertion, target: redactTarget(assertion.target) }
          : assertion,
      ),
      textBody: configuration.assertions.textBody.map((assertion) => ({
        ...assertion,
        target: redactTarget(assertion.target),
      })),
      jsonBody: configuration.assertions.jsonBody.map((assertion) =>
        'target' in assertion
          ? { ...assertion, target: redactTarget(assertion.target) }
          : assertion,
      ),
    },
  };
}

function toPendingRoundResponse(round: CheckRoundRecord): CheckRoundResponse {
  return {
    id: round.id,
    monitorId: round.monitorId,
    trigger: round.trigger,
    status: round.status,
    assignmentStatus: 'PENDING',
    createdAt: round.createdAt.toISOString(),
    result: null,
  };
}

function toCheckRoundResponse(round: CheckHistoryDetail): CheckRoundResponse {
  return {
    id: round.id,
    monitorId: round.monitorId,
    trigger: round.trigger,
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

function toHistoryListItem(round: CheckHistoryListItem) {
  return {
    ...round,
    createdAt: round.createdAt.toISOString(),
    result: round.result
      ? { ...round.result, checkedAt: round.result.checkedAt.toISOString() }
      : null,
  };
}
