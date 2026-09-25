import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  ManualRoundRepository,
  MonitorNotFoundError,
  MonitorNotRunnableError,
  MonitorRepository,
  MonitorUpdateNotFoundError,
  type CheckRoundRecord,
  type ManualRoundResult,
  type MonitorRecord,
} from '@watchrail/db';
import { createMonitor, MonitorInputError, parseHttpStatusPolicy } from '@watchrail/domain';
import type { CreateMonitorCommand } from '@watchrail/domain';
import type { RequestContext } from './request-context.js';

@Injectable()
export class MonitorsService {
  constructor(
    @Inject(MonitorRepository) private readonly monitors: MonitorRepository,
    @Inject(ManualRoundRepository) private readonly manualRounds: ManualRoundRepository,
  ) {}

  async create(context: RequestContext, command: CreateMonitorCommand): Promise<MonitorRecord> {
    try {
      const monitor = createMonitor(command);
      return await this.monitors.create(context.organizationId, monitor);
    } catch (error) {
      if (error instanceof MonitorInputError) {
        throw new BadRequestException({
          code: 'VALIDATION_FAILED',
          message: error.message,
          fields: error.fields,
        });
      }
      throw error;
    }
  }

  list(context: RequestContext): Promise<MonitorRecord[]> {
    return this.monitors.listForOrganization(context.organizationId);
  }

  async updateStatusPolicy(
    context: RequestContext,
    monitorId: string,
    value: unknown,
  ): Promise<MonitorRecord> {
    try {
      const statusPolicy = parseHttpStatusPolicy(value);
      return await this.monitors.updateStatusPolicy(
        context.organizationId,
        monitorId,
        statusPolicy,
      );
    } catch (error) {
      if (error instanceof MonitorInputError) {
        throw new BadRequestException({
          code: 'VALIDATION_FAILED',
          message: error.message,
          fields: error.fields,
        });
      }
      if (error instanceof MonitorUpdateNotFoundError) {
        throw new NotFoundException({ code: 'MONITOR_NOT_FOUND', message: error.message });
      }
      throw error;
    }
  }

  async runNow(context: RequestContext, monitorId: string): Promise<CheckRoundRecord> {
    try {
      return await this.manualRounds.create(context.organizationId, monitorId);
    } catch (error) {
      if (error instanceof MonitorNotFoundError) {
        throw new NotFoundException({ code: 'MONITOR_NOT_FOUND', message: error.message });
      }

      if (error instanceof MonitorNotRunnableError) {
        throw new ConflictException({ code: 'MONITOR_NOT_RUNNABLE', message: error.message });
      }

      throw error;
    }
  }

  async getManualRound(
    context: RequestContext,
    monitorId: string,
    roundId: string,
  ): Promise<ManualRoundResult> {
    const round = await this.manualRounds.findForOrganization(
      context.organizationId,
      monitorId,
      roundId,
    );

    if (!round) {
      throw new NotFoundException({
        code: 'CHECK_ROUND_NOT_FOUND',
        message: 'Manual check round not found.',
      });
    }

    return round;
  }
}
