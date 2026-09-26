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
import {
  createMonitor,
  MonitorInputError,
  normalizeRequestHeaderUpdates,
  parseHttpMonitorSettings,
  parseHttpStatusPolicy,
  RequestHeaderInputError,
} from '@watchrail/domain';
import type { CreateMonitorCommand } from '@watchrail/domain';
import { storeRequestHeaders } from '@watchrail/http-header-security';
import { APP_CONFIG, type AppConfig } from './config.js';
import type { RequestContext } from './request-context.js';

@Injectable()
export class MonitorsService {
  constructor(
    @Inject(MonitorRepository) private readonly monitors: MonitorRepository,
    @Inject(ManualRoundRepository) private readonly manualRounds: ManualRoundRepository,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async create(context: RequestContext, command: CreateMonitorCommand): Promise<MonitorRecord> {
    try {
      const monitor = createMonitor(command);
      const monitorId = randomUUID();
      const requestHeaders = storeRequestHeaders(
        monitor.requestHeaders,
        [],
        { organizationId: context.organizationId, monitorId },
        this.config.headerEncryptionKeyring,
      );
      return await this.monitors.create(context.organizationId, monitorId, monitor, requestHeaders);
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

  async updateRequestHeaders(
    context: RequestContext,
    monitorId: string,
    value: unknown,
  ): Promise<MonitorRecord> {
    try {
      const updates = normalizeRequestHeaderUpdates(value);
      return await this.monitors.updateRequestHeaders(
        context.organizationId,
        monitorId,
        (current) =>
          storeRequestHeaders(
            updates,
            current,
            { organizationId: context.organizationId, monitorId },
            this.config.headerEncryptionKeyring,
          ),
      );
    } catch (error) {
      if (error instanceof RequestHeaderInputError) {
        throw new BadRequestException({
          code: 'VALIDATION_FAILED',
          message: error.message,
          fields: { requestHeaders: error.issues },
        });
      }
      if (error instanceof MonitorUpdateNotFoundError) {
        throw new NotFoundException({ code: 'MONITOR_NOT_FOUND', message: error.message });
      }
      if (error instanceof Error && error.message.startsWith('Cannot retain missing sensitive')) {
        throw new BadRequestException({
          code: 'VALIDATION_FAILED',
          message: 'Request headers are invalid.',
          fields: { requestHeaders: [error.message] },
        });
      }
      throw error;
    }
  }

  list(context: RequestContext): Promise<MonitorRecord[]> {
    return this.monitors.listForOrganization(context.organizationId);
  }

  async updateHttpSettings(
    context: RequestContext,
    monitorId: string,
    value: unknown,
  ): Promise<MonitorRecord> {
    try {
      const settings = parseHttpMonitorSettings(value);
      return await this.monitors.updateHttpSettings(context.organizationId, monitorId, settings);
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
import { randomUUID } from 'node:crypto';
