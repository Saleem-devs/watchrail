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
  AvailabilityHistoryQueryError,
  IncidentHistoryQueryError,
  IncidentMonitorNotFoundError,
  IncidentReadRepository,
  MonitorNotFoundError,
  MonitorNotRunnableError,
  MonitorRepository,
  ProjectRepository,
  ArchivedMonitorLifecycleError,
  MonitorUpdateNotFoundError,
  MonitorLocationUnavailableError,
  type CheckRoundRecord,
  type CheckHistoryDetail,
  type CheckHistoryPage,
  type AvailabilityHistory,
  type CurrentCheck,
  type CurrentIncidentState,
  type IncidentDetail,
  type IncidentHistoryPage,
  type OrganizationIncidentHistoryPage,
  type MonitorRecord,
  parseCheckHistoryQuery,
  parseAvailabilityHistoryQuery,
  parseIncidentHistoryQuery,
  parseOrganizationIncidentHistoryQuery,
  UptimeReadRepository,
  UptimeMonitorNotFoundError,
  UptimeQueryError,
  parseUptimeQuery,
  type UptimeMetrics,
} from '@watchrail/db';
import {
  AssertionInputError,
  EMPTY_ASSERTION_CONFIGURATION,
  createMonitor,
  MonitorInputError,
  normalizeRequestHeaderUpdates,
  parseHttpMonitorSettings,
  parseHttpStatusPolicy,
  parseMonitorConfigurationUpdate,
  parseMonitorLifecycleSettings,
  parseMonitorLocationSettings,
  parseMonitorScheduleSettings,
  RequestHeaderInputError,
} from '@watchrail/domain';
import type { CreateMonitorCommand } from '@watchrail/domain';
import { storeRequestHeaders } from '@watchrail/http-header-security';
import { AssertionRetentionError, storeResponseAssertions } from '@watchrail/assertion-security';
import { APP_CONFIG, type AppConfig } from '../../config/config.js';
import type { RequestContext } from '../../auth/request-context.js';
import type { MonitorListQuery } from './dto/monitor-list-query.js';

@Injectable()
export class MonitorsService {
  constructor(
    @Inject(MonitorRepository) private readonly monitors: MonitorRepository,
    @Inject(ProjectRepository) private readonly projects: ProjectRepository,
    @Inject(ManualRoundRepository) private readonly manualRounds: ManualRoundRepository,
    @Inject(CheckHistoryRepository) private readonly history: CheckHistoryRepository,
    @Inject(IncidentReadRepository) private readonly incidentReads: IncidentReadRepository,
    @Inject(UptimeReadRepository) private readonly uptimeReads: UptimeReadRepository,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async create(
    context: RequestContext,
    projectId: string,
    command: CreateMonitorCommand,
  ): Promise<MonitorRecord> {
    try {
      await this.assertProject(context, projectId);
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
        projectId,
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

  async updateName(
    context: RequestContext,
    monitorId: string,
    name: string,
  ): Promise<MonitorRecord> {
    try {
      return await this.monitors.updateName(context.organizationId, monitorId, name);
    } catch (error) {
      if (error instanceof MonitorUpdateNotFoundError) {
        throw new NotFoundException({ code: 'MONITOR_NOT_FOUND', message: error.message });
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
    query: MonitorListQuery = { name: undefined, location: undefined },
  ): Promise<{
    items: Array<{
      monitor: MonitorRecord;
      currentCheck: CurrentCheck | null;
      incidentState: CurrentIncidentState;
      uptime: UptimeMetrics;
    }>;
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  }> {
    const [monitors, currentChecks, incidentStates, uptimes] = await Promise.all([
      query.projectId
        ? this.monitors.listForProject(context.organizationId, query.projectId)
        : this.monitors.listForOrganization(context.organizationId),
      this.history.currentForOrganization(context.organizationId),
      this.incidentReads.currentForOrganization(context.organizationId),
      this.uptimeReads.currentForOrganization(context.organizationId),
    ]);
    const results = monitors.map((monitor) => ({
      monitor,
      uptime:
        uptimes.get(monitor.id) ??
        (() => {
          throw new Error('Monitor uptime projection is missing.');
        })(),
      currentCheck: currentChecks.get(monitor.id) ?? null,
      incidentState:
        incidentStates.get(monitor.id) ??
        (() => {
          throw new Error('Monitor incident state is missing.');
        })(),
    }));
    const name = query.name?.toLocaleLowerCase();
    const location = query.location?.toLocaleLowerCase();
    const filtered = results.filter(({ monitor, currentCheck }) => {
      if (name && !monitor.name.toLocaleLowerCase().includes(name)) return false;
      if (
        location &&
        !monitor.locations.some((candidate) => candidate.toLocaleLowerCase() === location)
      )
        return false;
      return !query.state || monitorListState(monitor, currentCheck) === query.state;
    });
    const page = query.page ?? 1;
    const limit = query.limit ?? Math.max(filtered.length, 1);
    const total = filtered.length;
    const totalPages = Math.max(1, Math.ceil(total / limit));
    const offset = (page - 1) * limit;
    return {
      items:
        query.page !== undefined || query.limit !== undefined
          ? filtered.slice(offset, offset + limit)
          : filtered,
      page,
      limit,
      total,
      totalPages,
    };
  }

  currentCheck(context: RequestContext, monitorId: string): Promise<CurrentCheck | null> {
    return this.history.currentForMonitor(context.organizationId, monitorId);
  }

  async uptime(context: RequestContext, monitorId: string, query: Record<string, unknown>) {
    try {
      return await this.uptimeReads.currentForMonitor(
        context.organizationId,
        monitorId,
        parseUptimeQuery(query),
      );
    } catch (error) {
      this.throwUptimeError(error);
    }
  }

  async dailyUptime(context: RequestContext, monitorId: string, query: Record<string, unknown>) {
    try {
      return await this.uptimeReads.dailyForMonitor(
        context.organizationId,
        monitorId,
        parseUptimeQuery(query, 'LAST_30_DAYS'),
      );
    } catch (error) {
      this.throwUptimeError(error);
    }
  }

  private throwUptimeError(error: unknown): never {
    if (error instanceof UptimeQueryError)
      throw new BadRequestException({ code: 'INVALID_UPTIME_QUERY', message: error.message });
    if (error instanceof UptimeMonitorNotFoundError)
      throw new NotFoundException({ code: 'MONITOR_NOT_FOUND', message: error.message });
    throw error;
  }

  currentIncidentState(context: RequestContext, monitorId: string): Promise<CurrentIncidentState> {
    return this.incidentReads.currentForMonitor(context.organizationId, monitorId);
  }

  async listIncidentHistory(
    context: RequestContext,
    monitorId: string,
    query: Record<string, unknown>,
  ): Promise<IncidentHistoryPage> {
    try {
      return await this.incidentReads.listForMonitor(
        context.organizationId,
        monitorId,
        parseIncidentHistoryQuery(query),
      );
    } catch (error) {
      if (error instanceof IncidentHistoryQueryError) {
        throw new BadRequestException({ code: 'INVALID_INCIDENT_QUERY', message: error.message });
      }
      if (error instanceof IncidentMonitorNotFoundError) {
        throw new NotFoundException({ code: 'MONITOR_NOT_FOUND', message: error.message });
      }
      throw error;
    }
  }

  async getIncident(
    context: RequestContext,
    monitorId: string,
    incidentId: string,
  ): Promise<IncidentDetail> {
    const incident = await this.incidentReads.findForMonitor(
      context.organizationId,
      monitorId,
      incidentId,
    );
    if (!incident) {
      throw new NotFoundException({ code: 'INCIDENT_NOT_FOUND', message: 'Incident not found.' });
    }
    return incident;
  }

  async listOrganizationIncidentHistory(
    context: RequestContext,
    query: Record<string, unknown>,
  ): Promise<OrganizationIncidentHistoryPage> {
    try {
      return await this.incidentReads.listForOrganization(
        context.organizationId,
        parseOrganizationIncidentHistoryQuery(query),
      );
    } catch (error) {
      if (error instanceof IncidentHistoryQueryError) {
        throw new BadRequestException({ code: 'INVALID_INCIDENT_QUERY', message: error.message });
      }
      throw error;
    }
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

  async updateConfiguration(
    context: RequestContext,
    monitorId: string,
    value: unknown,
  ): Promise<MonitorRecord> {
    try {
      const update = parseMonitorConfigurationUpdate(value);
      const requestHeaderUpdates = normalizeRequestHeaderUpdates(update.requestHeaders);
      return await this.monitors.updateConfiguration(
        context.organizationId,
        monitorId,
        update.settings,
        (current) =>
          storeRequestHeaders(
            requestHeaderUpdates,
            current,
            { organizationId: context.organizationId, monitorId },
            this.config.headerEncryptionKeyring,
          ),
        (current, method) =>
          storeResponseAssertions(
            update.assertions,
            current,
            method,
            { organizationId: context.organizationId, monitorId },
            this.config.assertionEncryptionKeyring,
            { allowRetain: true },
          ),
      );
    } catch (error) {
      if (error instanceof MonitorInputError) {
        throw new BadRequestException({
          code: 'VALIDATION_FAILED',
          message: error.message,
          fields: error.fields,
        });
      }
      if (error instanceof RequestHeaderInputError) {
        throw new BadRequestException({
          code: 'VALIDATION_FAILED',
          message: error.message,
          fields: { requestHeaders: error.issues },
        });
      }
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

  async updateLocations(
    context: RequestContext,
    monitorId: string,
    value: unknown,
  ): Promise<MonitorRecord> {
    try {
      const { locations } = parseMonitorLocationSettings(value);
      if (locations.length > 1 && !this.config.multiLocationExecutionEnabled) {
        throw new MonitorInputError({
          locations: ['Multi-location execution is not enabled.'],
        });
      }
      return await this.monitors.updateLocations(context.organizationId, monitorId, locations);
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
      if (error instanceof MonitorLocationUnavailableError) {
        throw new ConflictException({ code: 'PROBE_LOCATION_UNAVAILABLE', message: error.message });
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

  async availabilityHistory(
    context: RequestContext,
    monitorId: string,
    query: Record<string, unknown>,
  ): Promise<AvailabilityHistory> {
    try {
      return await this.history.availabilityForMonitor(
        context.organizationId,
        monitorId,
        parseAvailabilityHistoryQuery(query),
      );
    } catch (error) {
      if (error instanceof AvailabilityHistoryQueryError) {
        throw new BadRequestException({
          code: 'INVALID_AVAILABILITY_HISTORY_QUERY',
          message: error.message,
        });
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

  private async assertProject(context: RequestContext, projectId: string): Promise<void> {
    const project = await this.projects.findForOrganization(context.organizationId, projectId);
    if (!project) {
      throw new NotFoundException({
        code: 'PROJECT_NOT_FOUND',
        message: 'Project not found.',
      });
    }
  }
}

function monitorListState(
  monitor: MonitorRecord,
  currentCheck: CurrentCheck | null,
): NonNullable<MonitorListQuery['state']> {
  if (monitor.lifecycleState === 'PAUSED') return 'paused';
  if (
    currentCheck?.availability === 'UNAVAILABLE' ||
    currentCheck?.aggregateOutcome === 'DEGRADED' ||
    currentCheck?.aggregateOutcome === 'DOWN'
  )
    return 'attention';
  if (
    currentCheck?.availability === 'AVAILABLE' &&
    (currentCheck.aggregateOutcome == null || currentCheck.aggregateOutcome === 'UP')
  )
    return 'operational';
  return 'pending';
}

import { randomUUID } from 'node:crypto';
