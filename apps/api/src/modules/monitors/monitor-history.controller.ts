import { Controller, Get, HttpCode, Inject, Param, Post, Query, Req } from '@nestjs/common';
import { RequirePermission } from '../../auth/auth.guard.js';
import { MonitorsService } from './monitors.service.js';
import { PERMISSIONS } from '../../auth/permissions.js';
import type { RequestWithContext } from '../../auth/request-context.js';
import {
  type CheckRoundResponse,
  toCheckRoundResponse,
  toHistoryListItem,
  toAvailabilityHistoryResponse,
  toIncidentDetailResponse,
  toIncidentHistoryResponse,
  toPendingRoundResponse,
} from './monitors.presenter.js';

@Controller('monitors')
export class MonitorHistoryController {
  constructor(@Inject(MonitorsService) private readonly monitors: MonitorsService) {}

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

  @Get(':monitorId/availability-history')
  @RequirePermission(PERMISSIONS.CHECK_READ)
  async getAvailabilityHistory(
    @Req() request: RequestWithContext,
    @Param('monitorId') monitorId: string,
    @Query() query: Record<string, unknown>,
  ) {
    return {
      data: toAvailabilityHistoryResponse(
        await this.monitors.availabilityHistory(request.watchrailContext, monitorId, query),
      ),
    };
  }

  @Get(':monitorId/dns-record-history')
  @RequirePermission(PERMISSIONS.CHECK_READ)
  async getDnsRecordHistory(
    @Req() request: RequestWithContext,
    @Param('monitorId') monitorId: string,
    @Query() query: Record<string, unknown>,
  ) {
    const page = await this.monitors.listDnsRecordHistory(
      request.watchrailContext,
      monitorId,
      query,
    );
    const locationEvidence = (items: Array<{ location: string; answers: string[] }>) =>
      items.map((item) => ({ ...item }));
    return {
      data: {
        current: page.current
          ? {
              ...page.current,
              observedAt: page.current.observedAt.toISOString(),
              locationEvidence: locationEvidence(page.current.locationEvidence),
            }
          : null,
        candidate: page.candidate
          ? {
              ...page.candidate,
              firstObservedAt: page.candidate.firstObservedAt.toISOString(),
              locationEvidence: locationEvidence(page.candidate.locationEvidence),
            }
          : null,
        items: page.items.map((item) => ({
          ...item,
          detectedAt: item.detectedAt.toISOString(),
          confirmedAt: item.confirmedAt.toISOString(),
          beforeLocationEvidence: locationEvidence(item.beforeLocationEvidence),
          afterLocationEvidence: locationEvidence(item.afterLocationEvidence),
        })),
      },
      page: { nextCursor: page.nextCursor },
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
}
