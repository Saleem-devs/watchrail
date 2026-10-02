import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  ManualRoundRepository,
  CheckHistoryRepository,
  CheckHistoryMonitorNotFoundError,
  CheckHistoryQueryError,
  MonitorNotFoundError,
  MonitorNotRunnableError,
  MonitorRepository,
  ArchivedMonitorLifecycleError,
  MonitorUpdateNotFoundError,
  type CheckRoundRecord,
  type CheckHistoryDetail,
  type CheckHistoryPage,
  type CurrentCheck,
  type MonitorRecord,
  parseCheckHistoryQuery,
} from '@watchrail/db';
import {
  AssertionInputError,
  EMPTY_ASSERTION_CONFIGURATION,
  createMonitor,
  MonitorInputError,
  normalizeRequestHeaderUpdates,
  parseHttpMonitorSettings,
  parseHttpStatusPolicy,
  parseMonitorLifecycleSettings,
  parseMonitorScheduleSettings,
  RequestHeaderInputError,
} from '@watchrail/domain';
import type { CreateMonitorCommand } from '@watchrail/domain';
import { storeRequestHeaders } from '@watchrail/http-header-security';
import { AssertionRetentionError, storeResponseAssertions } from '@watchrail/assertion-security';
import { APP_CONFIG, type AppConfig } from './config.js';
import type { RequestContext } from './request-context.js';

@Injectable()
export class MonitorsService {
  constructor(
    @Inject(MonitorRepository) private readonly monitors: MonitorRepository,
    @Inject(ManualRoundRepository) private readonly manualRounds: ManualRoundRepository,
    @Inject(CheckHistoryRepository) private readonly history: CheckHistoryRepository,
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
      const assertions = storeResponseAssertions(
        monitor.assertions,
        EMPTY_ASSERTION_CONFIGURATION,
        monitor.method,
        { organizationId: context.organizationId, monitorId },
        this.config.assertionEncryptionKeyring,
        { allowRetain: false },
      );
      return await this.monitors.create(
        context.organizationId,
        monitorId,
        monitor,
        requestHeaders,
        assertions,
      );
    } catch (error) {
      if (error instanceof MonitorInputError || error instanceof AssertionInputError) {
        throw new BadRequestException({
          code: 'VALIDATION_FAILED',
          message: error.message,
          fields: error instanceof MonitorInputError ? error.fields : { assertions: error.issues },
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

  async updateAssertions(
    context: RequestContext,
    monitorId: string,
    value: unknown,
  ): Promise<MonitorRecord> {
    try {
      return await this.monitors.updateAssertions(
        context.organizationId,
        monitorId,
        (current, method) =>
          storeResponseAssertions(
            value,
            current,
            method,
            { organizationId: context.organizationId, monitorId },
            this.config.assertionEncryptionKeyring,
            { allowRetain: true },
          ),
      );
    } catch (error) {
      if (error instanceof AssertionInputError || error instanceof AssertionRetentionError) {
        throw new BadRequestException({
          code: 'VALIDATION_FAILED',
          message: 'Response assertions are invalid.',
          fields: {
            assertions: error instanceof AssertionInputError ? error.issues : [error.message],
          },
        });
      }
      if (error instanceof MonitorUpdateNotFoundError) {
        throw new NotFoundException({ code: 'MONITOR_NOT_FOUND', message: error.message });
      }
      throw error;
    }
  }

  async list(
    context: RequestContext,
  ): Promise<Array<{ monitor: MonitorRecord; currentCheck: CurrentCheck | null }>> {
    const [monitors, currentChecks] = await Promise.all([
      this.monitors.listForOrganization(context.organizationId),
      this.history.currentForOrganization(context.organizationId),
    ]);
    return monitors.map((monitor) => ({
      monitor,
      currentCheck: currentChecks.get(monitor.id) ?? null,
    }));
  }

  currentCheck(context: RequestContext, monitorId: string): Promise<CurrentCheck | null> {
    return this.history.currentForMonitor(context.organizationId, monitorId);
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
      if (error instanceof MonitorInputError || error instanceof AssertionInputError) {
        throw new BadRequestException({
          code: 'VALIDATION_FAILED',
          message: error.message,
          fields: error instanceof MonitorInputError ? error.fields : { assertions: error.issues },
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

  async updateScheduleSettings(
    context: RequestContext,
    monitorId: string,
    value: unknown,
  ): Promise<MonitorRecord> {
    try {
      const { intervalSeconds } = parseMonitorScheduleSettings(value);
      return await this.monitors.updateScheduleSettings(
        context.organizationId,
        monitorId,
        intervalSeconds,
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

  async updateLifecycle(
    context: RequestContext,
    monitorId: string,
    value: unknown,
  ): Promise<MonitorRecord> {
    try {
      const { lifecycleState } = parseMonitorLifecycleSettings(value);
      return await this.monitors.updateLifecycle(context.organizationId, monitorId, lifecycleState);
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
      if (error instanceof ArchivedMonitorLifecycleError) {
        throw new ConflictException({ code: 'MONITOR_ARCHIVED', message: error.message });
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

  async listCheckHistory(
    context: RequestContext,
    monitorId: string,
    query: Record<string, unknown>,
  ): Promise<CheckHistoryPage> {
    try {
      return await this.history.listForMonitor(
        context.organizationId,
        monitorId,
        parseCheckHistoryQuery(query),
      );
    } catch (error) {
      if (error instanceof CheckHistoryQueryError) {
        throw new BadRequestException({ code: 'INVALID_HISTORY_QUERY', message: error.message });
      }
      if (error instanceof CheckHistoryMonitorNotFoundError) {
        throw new NotFoundException({ code: 'MONITOR_NOT_FOUND', message: error.message });
      }
      throw error;
    }
  }

  async getCheckRound(
    context: RequestContext,
    monitorId: string,
    roundId: string,
  ): Promise<CheckHistoryDetail> {
    const round = await this.history.findForMonitor(context.organizationId, monitorId, roundId);

    if (!round) {
      throw new NotFoundException({
        code: 'CHECK_ROUND_NOT_FOUND',
        message: 'Check round not found.',
      });
    }

    return round;
  }
}
import { randomUUID } from 'node:crypto';
