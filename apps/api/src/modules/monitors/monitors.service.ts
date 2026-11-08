import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  ManualRoundRepository,
  InboundMonitorManualExecutionError,
  CheckHistoryRepository,
  CheckHistoryMonitorNotFoundError,
  CheckHistoryQueryError,
  AvailabilityHistoryQueryError,
  IncidentHistoryQueryError,
  IncidentMonitorNotFoundError,
  IncidentReadRepository,
  IncidentActionRepository,
  IncidentActionConflictError,
  IncidentActionNotFoundError,
  IncidentResolutionNoteError,
  IncidentSilenceWindowError,
  MonitorNotFoundError,
  MonitorNotRunnableError,
  MonitorRepository,
  ProjectRepository,
  ArchivedMonitorLifecycleError,
  MonitorUpdateNotFoundError,
  MonitorProtocolMismatchError,
  MonitorLocationUnavailableError,
  WorkspaceSecretBindingError,
  WorkspaceSecretUseAuthorizationError,
  type CheckRoundRecord,
  type CheckHistoryDetail,
  type CheckHistoryPage,
  type AvailabilityHistory,
  type CurrentCheck,
  type CurrentIncidentState,
  type IncidentDetail,
  type IncidentActionEventRecord,
  type IncidentHistoryPage,
  type OrganizationIncidentDetail,
  type OrganizationIncidentHistoryItem,
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
  parseTcpMonitorSettings,
  parseDnsMonitorSettings,
  parseHeartbeatMonitorSettings,
  HeartbeatInputError,
  parseMonitorConfigurationUpdate,
  parseMonitorLifecycleSettings,
  parseMonitorLocationSettings,
  parseMonitorScheduleSettings,
  parseApiWorkflowConfiguration,
  RequestHeaderInputError,
  TcpMonitorInputError,
  DnsMonitorInputError,
  parseDomainExpiryMonitorSettings,
  DomainExpiryInputError,
} from '@watchrail/domain';
import type { CreateMonitorCommand } from '@watchrail/domain';
import { RequestHeaderStorageError, storeRequestHeaders } from '@watchrail/http-header-security';
import { AssertionRetentionError, storeResponseAssertions } from '@watchrail/assertion-security';
import { APP_CONFIG, type AppConfig } from '../../config/config.js';
import { requestCan, type RequestContext } from '../../auth/request-context.js';
import { PERMISSIONS } from '../../auth/permissions.js';
import type { MonitorListQuery } from './dto/monitor-list-query.js';
import {
  ApiWorkflowConfigurationError,
  storeApiWorkflowConfiguration,
} from './api-workflow-configuration.js';

@Injectable()
export class MonitorsService {
  constructor(
    @Inject(MonitorRepository) private readonly monitors: MonitorRepository,
    @Inject(ProjectRepository) private readonly projects: ProjectRepository,
    @Inject(ManualRoundRepository) private readonly manualRounds: ManualRoundRepository,
    @Inject(CheckHistoryRepository) private readonly history: CheckHistoryRepository,
    @Inject(IncidentReadRepository) private readonly incidentReads: IncidentReadRepository,
    @Inject(IncidentActionRepository) private readonly incidentActions: IncidentActionRepository,
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
      if (monitor.type === 'API_WORKFLOW') {
        const workflow = storeApiWorkflowConfiguration(
          monitor.workflow,
          null,
          { organizationId: context.organizationId, monitorId },
          {
            headers: this.config.headerEncryptionKeyring,
            assertions: this.config.assertionEncryptionKeyring,
          },
          { allowRetain: false },
        );
        this.assertSecretUse(context, workflowUsesWorkspaceSecrets(workflow));
        return await this.monitors.create(
          context.organizationId,
          monitorId,
          monitor,
          [],
          EMPTY_ASSERTION_CONFIGURATION,
          projectId,
          workflow,
        );
      }
      if (monitor.type === 'HEARTBEAT') {
        const heartbeatToken = randomBytes(32).toString('base64url');
        const heartbeatTokenHash = createHash('sha256')
          .update(heartbeatToken, 'utf8')
          .digest('hex');
        const created = await this.monitors.create(
          context.organizationId,
          monitorId,
          monitor,
          [],
          EMPTY_ASSERTION_CONFIGURATION,
          projectId,
          undefined,
          heartbeatTokenHash,
        );
        return Object.assign(created, { heartbeatToken });
      }
      if (monitor.type !== 'HTTP') {
        return await this.monitors.create(
          context.organizationId,
          monitorId,
          monitor,
          [],
          EMPTY_ASSERTION_CONFIGURATION,
          projectId,
        );
      }
      const requestHeaders = storeRequestHeaders(
        monitor.requestHeaders,
        [],
        { organizationId: context.organizationId, monitorId },
        this.config.headerEncryptionKeyring,
      );
      this.assertSecretUse(context, requestHeadersUseWorkspaceSecrets(requestHeaders));
      const assertions = storeResponseAssertions(
        monitor.assertions,
        EMPTY_ASSERTION_CONFIGURATION,
        monitor.method,
        { organizationId: context.organizationId, monitorId },
        this.config.assertionEncryptionKeyring,
        { allowRetain: false },
      );
      this.assertSecretUse(context, containsWorkspaceSecretReference(assertions));
      return await this.monitors.create(
        context.organizationId,
        monitorId,
        monitor,
        requestHeaders,
        assertions,
        projectId,
      );
    } catch (error) {
      if (
        error instanceof MonitorInputError ||
        error instanceof AssertionInputError ||
        error instanceof AssertionRetentionError ||
        error instanceof RequestHeaderInputError ||
        error instanceof ApiWorkflowConfigurationError
      ) {
        throw new BadRequestException({
          code: 'VALIDATION_FAILED',
          message: error.message,
          fields:
            error instanceof MonitorInputError
              ? error.fields
              : error instanceof AssertionInputError
                ? { assertions: error.issues }
                : error instanceof RequestHeaderInputError
                  ? command.type === 'API_WORKFLOW'
                    ? { workflow: error.issues }
                    : { requestHeaders: error.issues }
                  : { workflow: [error.message] },
        });
      }
      if (error instanceof WorkspaceSecretBindingError) {
        throw workspaceSecretReferenceValidationError(
          command.type === 'API_WORKFLOW'
            ? 'workflow'
            : containsWorkspaceSecretReference(command.assertions)
              ? 'assertions'
              : 'requestHeaders',
        );
      }
      throw error;
    }
  }

  async updateApiWorkflow(
    context: RequestContext,
    monitorId: string,
    value: unknown,
  ): Promise<MonitorRecord> {
    try {
      const input = parseApiWorkflowConfiguration(value);
      this.assertSecretUse(context, workflowUsesWorkspaceSecrets(input));
      return await this.monitors.updateApiWorkflow(
        context.organizationId,
        monitorId,
        (current) =>
          storeApiWorkflowConfiguration(
            input,
            current,
            { organizationId: context.organizationId, monitorId },
            {
              headers: this.config.headerEncryptionKeyring,
              assertions: this.config.assertionEncryptionKeyring,
            },
            { allowRetain: true },
          ),
        requestCan(context, PERMISSIONS.SECRET_USE),
      );
    } catch (error) {
      if (
        error instanceof MonitorInputError ||
        error instanceof AssertionInputError ||
        error instanceof AssertionRetentionError ||
        error instanceof RequestHeaderInputError ||
        error instanceof ApiWorkflowConfigurationError ||
        error instanceof RequestHeaderStorageError
      ) {
        throw new BadRequestException({
          code: 'VALIDATION_FAILED',
          message: 'API workflow configuration is invalid.',
          fields: {
            workflow:
              error instanceof MonitorInputError
                ? (error.fields.workflow ?? [error.message])
                : error instanceof AssertionInputError || error instanceof RequestHeaderInputError
                  ? error.issues
                  : [error.message],
          },
        });
      }
      if (error instanceof MonitorUpdateNotFoundError) {
        throw new NotFoundException({ code: 'MONITOR_NOT_FOUND', message: error.message });
      }
      if (error instanceof MonitorProtocolMismatchError) {
        throw new ConflictException({ code: 'MONITOR_PROTOCOL_MISMATCH', message: error.message });
      }
      if (error instanceof WorkspaceSecretBindingError) {
        throw workspaceSecretReferenceValidationError('workflow');
      }
      if (error instanceof WorkspaceSecretUseAuthorizationError) {
        throw workspaceSecretUseForbidden();
      }
      throw error;
    }
  }

  async updateDnsSettings(
    context: RequestContext,
    monitorId: string,
    value: unknown,
  ): Promise<MonitorRecord> {
    try {
      const settings = parseDnsMonitorSettings(value);
      return await this.monitors.updateDnsSettings(context.organizationId, monitorId, settings);
    } catch (error) {
      if (error instanceof DnsMonitorInputError) {
        throw new BadRequestException({
          code: 'VALIDATION_FAILED',
          message: error.message,
          fields: error.fields,
        });
      }
      if (error instanceof MonitorUpdateNotFoundError) {
        throw new NotFoundException({ code: 'MONITOR_NOT_FOUND', message: error.message });
      }
      if (error instanceof MonitorProtocolMismatchError) {
        throw new ConflictException({ code: 'MONITOR_PROTOCOL_MISMATCH', message: error.message });
      }
      throw error;
    }
  }

  async updateDomainExpirySettings(
    context: RequestContext,
    monitorId: string,
    value: unknown,
  ): Promise<MonitorRecord> {
    try {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new DomainExpiryInputError({ domainName: ['Enter a registered domain name.'] });
      }
      const input = value as Record<string, unknown>;
      const settings = parseDomainExpiryMonitorSettings({
        domainName: input.domainName,
        warningDays: input.warningDays,
        timeoutMs: input.timeoutMs,
      });
      return await this.monitors.updateDomainExpirySettings(
        context.organizationId,
        monitorId,
        settings,
      );
    } catch (error) {
      if (error instanceof DomainExpiryInputError) {
        throw new BadRequestException({
          code: 'VALIDATION_FAILED',
          message: error.message,
          fields: error.fields,
        });
      }
      if (error instanceof MonitorUpdateNotFoundError) {
        throw new NotFoundException({ code: 'MONITOR_NOT_FOUND', message: error.message });
      }
      if (error instanceof MonitorProtocolMismatchError) {
        throw new ConflictException({ code: 'MONITOR_PROTOCOL_MISMATCH', message: error.message });
      }
      throw error;
    }
  }

  async updateHeartbeatSettings(
    context: RequestContext,
    monitorId: string,
    value: unknown,
  ): Promise<MonitorRecord> {
    try {
      const heartbeat = parseHeartbeatMonitorSettings(value);
      return await this.monitors.updateHeartbeatSettings(
        context.organizationId,
        monitorId,
        heartbeat,
      );
    } catch (error) {
      if (error instanceof HeartbeatInputError) {
        throw new BadRequestException({
          code: 'VALIDATION_FAILED',
          message: error.message,
          fields: error.fields,
        });
      }
      if (error instanceof MonitorUpdateNotFoundError) {
        throw new NotFoundException({ code: 'MONITOR_NOT_FOUND', message: error.message });
      }
      if (error instanceof MonitorProtocolMismatchError) {
        throw new ConflictException({ code: 'MONITOR_PROTOCOL_MISMATCH', message: error.message });
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
      this.assertSecretUse(context, requestHeadersUseWorkspaceSecrets(updates));
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
      if (error instanceof MonitorProtocolMismatchError) {
        throw new ConflictException({ code: 'MONITOR_PROTOCOL_MISMATCH', message: error.message });
      }
      if (error instanceof RequestHeaderStorageError) {
        throw new BadRequestException({
          code: 'VALIDATION_FAILED',
          message: 'Request headers are invalid.',
          fields: { requestHeaders: [error.message] },
        });
      }
      if (error instanceof WorkspaceSecretBindingError) {
        throw workspaceSecretReferenceValidationError('requestHeaders');
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
      this.assertSecretUse(context, containsWorkspaceSecretReference(value));
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
      if (error instanceof MonitorProtocolMismatchError) {
        throw new ConflictException({ code: 'MONITOR_PROTOCOL_MISMATCH', message: error.message });
      }
      if (error instanceof WorkspaceSecretBindingError) {
        throw workspaceSecretReferenceValidationError('assertions');
      }
      throw error;
    }
  }

  async list(
    context: RequestContext,
    query: MonitorListQuery = { name: undefined, location: undefined, type: undefined },
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
    summary: {
      total: number;
      operational: number;
      attention: number;
      paused: number;
      pending: number;
      openIncidents: number;
      averageUptimePercent: number | null;
      averageCoveragePercent: number | null;
    };
  }> {
    const [monitors, currentChecks, incidentStates, uptimes] = await Promise.all([
      query.projectId
        ? this.monitors.listForProject(context.organizationId, query.projectId)
        : this.monitors.listForOrganization(context.organizationId),
      this.history.currentForOrganization(context.organizationId),
      this.incidentReads.currentForOrganization(context.organizationId),
      this.uptimeReads.currentForOrganization(context.organizationId),
    ]);
    const results = monitors
      .filter((monitor) => !query.type || monitor.type === query.type)
      .map((monitor) => ({
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
      summary: monitorListSummary(results),
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

  async getOrganizationIncident(
    context: RequestContext,
    incidentId: string,
  ): Promise<OrganizationIncidentDetail> {
    const incident = await this.incidentReads.findForOrganization(
      context.organizationId,
      incidentId,
    );
    if (!incident) {
      throw new NotFoundException({ code: 'INCIDENT_NOT_FOUND', message: 'Incident not found.' });
    }
    return incident;
  }

  async listRelatedOrganizationIncidents(
    context: RequestContext,
    incidentId: string,
  ): Promise<OrganizationIncidentHistoryItem[]> {
    await this.getOrganizationIncident(context, incidentId);
    return this.incidentReads.listRelatedForOrganization(context.organizationId, incidentId);
  }

  async listIncidentActionEvents(
    context: RequestContext,
    incidentId: string,
  ): Promise<IncidentActionEventRecord[]> {
    try {
      return await this.incidentActions.listEvents(context.organizationId, incidentId);
    } catch (error) {
      this.throwIncidentActionError(error);
    }
  }

  async acknowledgeIncident(context: RequestContext, incidentId: string) {
    try {
      return await this.incidentActions.acknowledge(
        context.organizationId,
        incidentId,
        context.actorId,
      );
    } catch (error) {
      this.throwIncidentActionError(error);
    }
  }

  async silenceIncident(context: RequestContext, incidentId: string, value: unknown) {
    try {
      return await this.incidentActions.silence(
        context.organizationId,
        incidentId,
        context.actorId,
        parseSilenceUntil(value),
      );
    } catch (error) {
      this.throwIncidentActionError(error);
    }
  }

  async unsilenceIncident(context: RequestContext, incidentId: string) {
    try {
      return await this.incidentActions.unsilence(
        context.organizationId,
        incidentId,
        context.actorId,
      );
    } catch (error) {
      this.throwIncidentActionError(error);
    }
  }

  async resolveIncident(context: RequestContext, incidentId: string, value: unknown) {
    try {
      return await this.incidentActions.resolve(
        context.organizationId,
        incidentId,
        context.actorId,
        parseResolutionNote(value),
      );
    } catch (error) {
      this.throwIncidentActionError(error);
    }
  }

  private throwIncidentActionError(error: unknown): never {
    if (error instanceof IncidentActionNotFoundError) {
      throw new NotFoundException({ code: 'INCIDENT_NOT_FOUND', message: error.message });
    }
    if (error instanceof IncidentActionConflictError) {
      throw new ConflictException({ code: 'INCIDENT_NOT_OPEN', message: error.message });
    }
    if (
      error instanceof IncidentSilenceWindowError ||
      error instanceof IncidentResolutionNoteError
    ) {
      throw new BadRequestException({ code: 'VALIDATION_FAILED', message: error.message });
    }
    throw error;
  }

  async updateHttpSettings(
    context: RequestContext,
    monitorId: string,
    value: unknown,
  ): Promise<MonitorRecord> {
    try {
      const settings = parseHttpMonitorSettings(value);
      return await this.monitors.updateHttpSettings(
        context.organizationId,
        monitorId,
        settings,
        requestCan(context, PERMISSIONS.SECRET_USE),
      );
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
      if (error instanceof MonitorProtocolMismatchError) {
        throw new ConflictException({ code: 'MONITOR_PROTOCOL_MISMATCH', message: error.message });
      }
      if (error instanceof WorkspaceSecretUseAuthorizationError) {
        throw workspaceSecretUseForbidden();
      }
      throw error;
    }
  }

  async updateTcpSettings(
    context: RequestContext,
    monitorId: string,
    value: unknown,
  ): Promise<MonitorRecord> {
    try {
      const settings = parseTcpMonitorSettings(value);
      return await this.monitors.updateTcpSettings(context.organizationId, monitorId, settings);
    } catch (error) {
      if (error instanceof MonitorInputError || error instanceof TcpMonitorInputError) {
        throw new BadRequestException({
          code: 'VALIDATION_FAILED',
          message: error.message,
          fields: error.fields,
        });
      }
      if (error instanceof MonitorUpdateNotFoundError) {
        throw new NotFoundException({ code: 'MONITOR_NOT_FOUND', message: error.message });
      }
      if (error instanceof MonitorProtocolMismatchError) {
        throw new ConflictException({ code: 'MONITOR_PROTOCOL_MISMATCH', message: error.message });
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
      this.assertSecretUse(
        context,
        requestHeadersUseWorkspaceSecrets(requestHeaderUpdates) ||
          containsWorkspaceSecretReference(update.assertions),
      );
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
        requestCan(context, PERMISSIONS.SECRET_USE),
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
      if (error instanceof MonitorProtocolMismatchError) {
        throw new ConflictException({ code: 'MONITOR_PROTOCOL_MISMATCH', message: error.message });
      }
      if (error instanceof RequestHeaderStorageError) {
        throw new BadRequestException({
          code: 'VALIDATION_FAILED',
          message: 'Request headers are invalid.',
          fields: { requestHeaders: [error.message] },
        });
      }
      if (error instanceof WorkspaceSecretBindingError) {
        throw workspaceSecretReferenceValidationError('requestHeaders');
      }
      if (error instanceof WorkspaceSecretUseAuthorizationError) {
        throw workspaceSecretUseForbidden();
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
      if (error instanceof MonitorProtocolMismatchError) {
        throw new ConflictException({ code: 'MONITOR_PROTOCOL_MISMATCH', message: error.message });
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
      return await this.monitors.updateLifecycle(
        context.organizationId,
        monitorId,
        lifecycleState,
        requestCan(context, PERMISSIONS.SECRET_USE),
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
      if (error instanceof ArchivedMonitorLifecycleError) {
        throw new ConflictException({ code: 'MONITOR_ARCHIVED', message: error.message });
      }
      if (error instanceof WorkspaceSecretUseAuthorizationError) {
        throw workspaceSecretUseForbidden();
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
      return await this.monitors.updateLocations(
        context.organizationId,
        monitorId,
        locations,
        requestCan(context, PERMISSIONS.SECRET_USE),
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
      if (error instanceof MonitorLocationUnavailableError) {
        throw new ConflictException({ code: 'PROBE_LOCATION_UNAVAILABLE', message: error.message });
      }
      if (error instanceof WorkspaceSecretUseAuthorizationError) {
        throw workspaceSecretUseForbidden();
      }
      throw error;
    }
  }

  async runNow(context: RequestContext, monitorId: string): Promise<CheckRoundRecord> {
    try {
      return await this.manualRounds.create(
        context.organizationId,
        monitorId,
        requestCan(context, PERMISSIONS.SECRET_USE),
      );
    } catch (error) {
      if (error instanceof MonitorNotFoundError) {
        throw new NotFoundException({ code: 'MONITOR_NOT_FOUND', message: error.message });
      }

      if (error instanceof MonitorNotRunnableError) {
        throw new ConflictException({ code: 'MONITOR_NOT_RUNNABLE', message: error.message });
      }

      if (error instanceof InboundMonitorManualExecutionError) {
        throw new ConflictException({ code: 'MONITOR_NOT_RUNNABLE', message: error.message });
      }

      if (error instanceof WorkspaceSecretUseAuthorizationError) {
        throw workspaceSecretUseForbidden();
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

  private assertSecretUse(context: RequestContext, required: boolean): void {
    if (required && !requestCan(context, PERMISSIONS.SECRET_USE)) {
      throw new ForbiddenException({
        code: 'WORKSPACE_SECRET_USE_FORBIDDEN',
        message: 'Permission to use workspace secrets is required for this operation.',
      });
    }
  }
}

function workspaceSecretUseForbidden(): ForbiddenException {
  return new ForbiddenException({
    code: 'WORKSPACE_SECRET_USE_FORBIDDEN',
    message: 'Permission to use workspace secrets is required for this operation.',
  });
}

function workspaceSecretReferenceValidationError(
  field: 'requestHeaders' | 'workflow' | 'assertions',
): BadRequestException {
  return new BadRequestException({
    code: 'VALIDATION_FAILED',
    message: 'A referenced workspace secret is unavailable.',
    fields: { [field]: ['Choose an active secret from this workspace.'] },
  });
}

function requestHeadersUseWorkspaceSecrets(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.some(
      (header) =>
        header !== null &&
        typeof header === 'object' &&
        Object.prototype.hasOwnProperty.call(header, 'secretReference'),
    )
  );
}

function workflowUsesWorkspaceSecrets(value: unknown): boolean {
  return containsWorkspaceSecretReference(value);
}

function containsWorkspaceSecretReference(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsWorkspaceSecretReference);
  if (value === null || typeof value !== 'object') return false;
  if (Object.prototype.hasOwnProperty.call(value, 'secretReference')) return true;
  return Object.values(value).some(containsWorkspaceSecretReference);
}

function parseSilenceUntil(value: unknown): Date {
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).length !== 1 ||
    !('until' in value) ||
    typeof value.until !== 'string'
  ) {
    throw new IncidentSilenceWindowError();
  }
  const until = new Date(value.until);
  if (!Number.isFinite(until.getTime())) throw new IncidentSilenceWindowError();
  return until;
}

function parseResolutionNote(value: unknown): string | null {
  if (value === undefined) return null;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new IncidentResolutionNoteError();
  }
  const keys = Object.keys(value);
  if (keys.some((key) => key !== 'note')) throw new IncidentResolutionNoteError();
  if (!('note' in value) || value.note === undefined || value.note === null || value.note === '') {
    return null;
  }
  if (typeof value.note !== 'string' || value.note.trim().length > 500) {
    throw new IncidentResolutionNoteError();
  }
  return value.note;
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

function monitorListSummary(
  rows: Array<{
    monitor: MonitorRecord;
    currentCheck: CurrentCheck | null;
    incidentState: CurrentIncidentState;
    uptime: UptimeMetrics;
  }>,
) {
  const summary = {
    total: rows.length,
    operational: 0,
    attention: 0,
    paused: 0,
    pending: 0,
    openIncidents: 0,
    averageUptimePercent: null as number | null,
    averageCoveragePercent: null as number | null,
  };
  const uptimes: number[] = [];
  const coverages: number[] = [];
  for (const row of rows) {
    const state = monitorListState(row.monitor, row.currentCheck);
    summary[state] += 1;
    if (row.incidentState.currentIncident) summary.openIncidents += 1;
    if (row.uptime.uptimePercent != null) uptimes.push(row.uptime.uptimePercent);
    if (row.uptime.coveragePercent != null) coverages.push(row.uptime.coveragePercent);
  }
  summary.averageUptimePercent = averageOrNull(uptimes);
  summary.averageCoveragePercent = averageOrNull(coverages);
  return summary;
}

function averageOrNull(values: number[]): number | null {
  return values.length === 0
    ? null
    : values.reduce((total, value) => total + value, 0) / values.length;
}
