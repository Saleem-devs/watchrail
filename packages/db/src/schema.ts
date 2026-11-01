import { sql } from 'drizzle-orm';
import {
  check,
  boolean,
  date,
  foreignKey,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import type { ExecuteCheckRoundJobV1, WebhookNotificationV1 } from '@watchrail/contracts';
import type { EncryptedWebhookSigningSecretV1 } from '@watchrail/webhook-security';
import {
  CHECK_ROUND_STATUSES,
  AVAILABILITY_WINDOW_STATES,
  CHECK_ROUND_TRIGGERS,
  EXECUTION_ASSIGNMENT_STATUSES,
  HTTP_METHODS,
  MONITOR_LIFECYCLE_STATES,
  PROBE_AGENT_STATUSES,
  PROBE_ATTEMPT_STATUSES,
  PROBE_CREDENTIAL_STATUSES,
  PROBE_LOCATION_STATUSES,
  HTTP_ENGINE_VERSION,
  HTTP_EXECUTION_POLICY_VERSION,
  type HttpStatusPolicy,
  type HttpRequestBody,
  type AssertionEvaluationV1,
  type HttpRedirectHop,
  type StoredRequestHeader,
  type ResponseAssertionConfigurationV1,
  EMPTY_ASSERTION_CONFIGURATION,
  EMPTY_ASSERTION_EVALUATION,
  type AggregateRoundDecisionV1,
  type ProbeObservationV1,
  type TlsCertificateEvidenceV1,
  type TlsCertificatePolicy,
} from '@watchrail/domain';

export const httpMethodEnum = pgEnum('http_method', HTTP_METHODS);

export const monitorLifecycleEnum = pgEnum('monitor_lifecycle_state', MONITOR_LIFECYCLE_STATES);

export const checkRoundTriggerEnum = pgEnum('check_round_trigger', CHECK_ROUND_TRIGGERS);

export const checkRoundStatusEnum = pgEnum('check_round_status', CHECK_ROUND_STATUSES);

export const executionAssignmentStatusEnum = pgEnum(
  'execution_assignment_status',
  EXECUTION_ASSIGNMENT_STATUSES,
);

export const checkResultOutcomeEnum = pgEnum('check_result_outcome', ['PASS', 'FAIL', 'UNKNOWN']);

export const checkResultStageEnum = pgEnum('check_result_stage', [
  'DNS',
  'CONNECT',
  'TLS',
  'HTTP',
  'PROBE',
]);

export const checkResultReasonEnum = pgEnum('check_result_reason', [
  'COMPLETED',
  'UNEXPECTED_STATUS',
  'REQUEST_TIMEOUT',
  'NAME_NOT_FOUND',
  'CONNECTION_REFUSED',
  'CERTIFICATE_EXPIRED',
  'CERTIFICATE_NOT_YET_VALID',
  'CERTIFICATE_HOSTNAME_MISMATCH',
  'CERTIFICATE_UNTRUSTED',
  'CERTIFICATE_EXPIRING',
  'TLS_HANDSHAKE_FAILED',
  'PROHIBITED_DESTINATION',
  'REDIRECT_LOOP',
  'TOO_MANY_REDIRECTS',
  'MISSING_REDIRECT_LOCATION',
  'INVALID_REDIRECT_LOCATION',
  'INSECURE_REDIRECT',
  'INTERNAL_ERROR',
]);

export const incidentStatusEnum = pgEnum('incident_status', ['OPEN', 'RESOLVED']);
export const notificationEventTypeEnum = pgEnum('notification_event_type', [
  'INCIDENT_OPENED',
  'INCIDENT_RESOLVED',
]);
export const availabilityStateEnum = pgEnum(
  'availability_window_state',
  AVAILABILITY_WINDOW_STATES,
);

export const probeLocationStatusEnum = pgEnum('probe_location_status', PROBE_LOCATION_STATUSES);
export const probeAgentStatusEnum = pgEnum('probe_agent_status', PROBE_AGENT_STATUSES);
export const probeCredentialStatusEnum = pgEnum(
  'probe_credential_status',
  PROBE_CREDENTIAL_STATUSES,
);
export const probeAttemptStatusEnum = pgEnum('probe_attempt_status', PROBE_ATTEMPT_STATUSES);

export const probeLocations = pgTable(
  'probe_locations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id').notNull(),
    name: varchar('name', { length: 120 }).notNull(),
    slug: varchar('slug', { length: 64 }).notNull(),
    status: probeLocationStatusEnum('status').notNull().default('ACTIVE'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('probe_locations_identity_unique').on(table.organizationId, table.id),
    unique('probe_locations_slug_unique').on(table.organizationId, table.slug),
    check('probe_locations_name_not_blank', sql`length(btrim(${table.name})) > 0`),
    check(
      'probe_locations_slug_format',
      sql`${table.slug} ~ '^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$' and ${table.slug} <> 'local'`,
    ),
    index('probe_locations_organization_idx').on(table.organizationId, table.createdAt, table.id),
  ],
);

export const probeAgents = pgTable(
  'probe_agents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id').notNull(),
    locationId: uuid('location_id').notNull(),
    name: varchar('name', { length: 120 }).notNull(),
    status: probeAgentStatusEnum('status').notNull().default('PENDING'),
    lastHeartbeatAt: timestamp('last_heartbeat_at', { withTimezone: true }),
    heartbeatIntervalMs: integer('heartbeat_interval_ms').notNull().default(15_000),
    engineVersion: varchar('engine_version', { length: 64 }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (table) => [
    unique('probe_agents_identity_unique').on(table.organizationId, table.id),
    unique('probe_agents_location_identity_unique').on(
      table.organizationId,
      table.id,
      table.locationId,
    ),
    foreignKey({
      name: 'probe_agents_location_fk',
      columns: [table.organizationId, table.locationId],
      foreignColumns: [probeLocations.organizationId, probeLocations.id],
    }),
    check('probe_agents_name_not_blank', sql`length(btrim(${table.name})) > 0`),
    check(
      'probe_agents_heartbeat_interval_range',
      sql`${table.heartbeatIntervalMs} between 5000 and 60000`,
    ),
    check(
      'probe_agents_revocation_consistent',
      sql`(${table.status} = 'REVOKED') = (${table.revokedAt} is not null)`,
    ),
    index('probe_agents_location_idx').on(
      table.organizationId,
      table.locationId,
      table.createdAt,
      table.id,
    ),
  ],
);

export const probeAgentEnrollments = pgTable(
  'probe_agent_enrollments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id').notNull(),
    locationId: uuid('location_id').notNull(),
    agentName: varchar('agent_name', { length: 120 }).notNull(),
    tokenVerifier: varchar('token_verifier', { length: 43 }).notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    consumedByAgentId: uuid('consumed_by_agent_id'),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('probe_agent_enrollments_identity_unique').on(table.organizationId, table.id),
    unique('probe_agent_enrollments_verifier_unique').on(table.tokenVerifier),
    foreignKey({
      name: 'probe_agent_enrollments_location_fk',
      columns: [table.organizationId, table.locationId],
      foreignColumns: [probeLocations.organizationId, probeLocations.id],
    }),
    foreignKey({
      name: 'probe_agent_enrollments_agent_fk',
      columns: [table.organizationId, table.consumedByAgentId, table.locationId],
      foreignColumns: [probeAgents.organizationId, probeAgents.id, probeAgents.locationId],
    }),
    check('probe_agent_enrollments_name_not_blank', sql`length(btrim(${table.agentName})) > 0`),
    check(
      'probe_agent_enrollments_verifier_format',
      sql`${table.tokenVerifier} ~ '^[A-Za-z0-9_-]{43}$'`,
    ),
    check(
      'probe_agent_enrollments_consumption_consistent',
      sql`(${table.consumedAt} is null) = (${table.consumedByAgentId} is null)`,
    ),
    check(
      'probe_agent_enrollments_terminal_exclusive',
      sql`not (${table.consumedAt} is not null and ${table.revokedAt} is not null)`,
    ),
    check(
      'probe_agent_enrollments_expiry_after_creation',
      sql`${table.expiresAt} > ${table.createdAt}`,
    ),
    index('probe_agent_enrollments_location_idx').on(
      table.organizationId,
      table.locationId,
      table.createdAt,
    ),
  ],
);

export const probeAgentCredentials = pgTable(
  'probe_agent_credentials',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id').notNull(),
    agentId: uuid('agent_id').notNull(),
    versionNumber: integer('version_number').notNull(),
    verifier: varchar('verifier', { length: 43 }).notNull(),
    status: probeCredentialStatusEnum('status').notNull().default('ACTIVE'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (table) => [
    unique('probe_agent_credentials_identity_unique').on(table.organizationId, table.id),
    unique('probe_agent_credentials_version_unique').on(
      table.organizationId,
      table.agentId,
      table.versionNumber,
    ),
    unique('probe_agent_credentials_verifier_unique').on(table.verifier),
    foreignKey({
      name: 'probe_agent_credentials_agent_fk',
      columns: [table.organizationId, table.agentId],
      foreignColumns: [probeAgents.organizationId, probeAgents.id],
    }).onDelete('cascade'),
    check('probe_agent_credentials_version_positive', sql`${table.versionNumber} > 0`),
    check(
      'probe_agent_credentials_verifier_format',
      sql`${table.verifier} ~ '^[A-Za-z0-9_-]{43}$'`,
    ),
    check(
      'probe_agent_credentials_revocation_consistent',
      sql`(${table.status} = 'REVOKED') = (${table.revokedAt} is not null)`,
    ),
    uniqueIndex('probe_agent_credentials_one_active_unique')
      .on(table.organizationId, table.agentId)
      .where(sql`${table.status} = 'ACTIVE'`),
  ],
);

export const monitorAvailabilityState = pgTable(
  'monitor_availability_state',
  {
    organizationId: uuid('organization_id').notNull(),
    monitorId: uuid('monitor_id').primaryKey(),
    currentState: availabilityStateEnum('current_state').notNull(),
    stateSince: timestamp('state_since', { withTimezone: true }).notNull(),
    accountedThrough: timestamp('accounted_through', { withTimezone: true }).notNull(),
    trackingStartedAt: timestamp('tracking_started_at', { withTimezone: true }).notNull(),
    enabledSince: timestamp('enabled_since', { withTimezone: true }),
    lastProcessedRoundCreatedAt: timestamp('last_processed_round_created_at', {
      withTimezone: true,
    }),
    lastProcessedRoundId: uuid('last_processed_round_id'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    foreignKey({
      name: 'monitor_availability_state_monitor_fk',
      columns: [table.monitorId, table.organizationId],
      foreignColumns: [monitors.id, monitors.organizationId],
    }).onDelete('cascade'),
    check(
      'monitor_availability_state_time_order',
      sql`${table.trackingStartedAt} <= ${table.stateSince} and ${table.stateSince} <= ${table.accountedThrough}`,
    ),
    check(
      'monitor_availability_state_epoch_consistent',
      sql`(${table.currentState} = 'EXCLUDED') = (${table.enabledSince} is null)`,
    ),
    check(
      'monitor_availability_state_watermark_consistent',
      sql`(${table.lastProcessedRoundCreatedAt} is null) = (${table.lastProcessedRoundId} is null)`,
    ),
    index('monitor_availability_state_flush_idx').on(table.accountedThrough, table.monitorId),
  ],
);

export const monitorAvailabilityDaily = pgTable(
  'monitor_availability_daily',
  {
    organizationId: uuid('organization_id').notNull(),
    monitorId: uuid('monitor_id').notNull(),
    dayUtc: date('day_utc').notNull(),
    availableMs: integer('available_ms').notNull().default(0),
    unavailableMs: integer('unavailable_ms').notNull().default(0),
    unknownMs: integer('unknown_ms').notNull().default(0),
    excludedMs: integer('excluded_ms').notNull().default(0),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.organizationId, table.monitorId, table.dayUtc] }),
    foreignKey({
      name: 'monitor_availability_daily_monitor_fk',
      columns: [table.monitorId, table.organizationId],
      foreignColumns: [monitors.id, monitors.organizationId],
    }).onDelete('cascade'),
    check(
      'monitor_availability_daily_duration_bounds',
      sql`${table.availableMs} >= 0 and ${table.unavailableMs} >= 0 and ${table.unknownMs} >= 0 and ${table.excludedMs} >= 0 and ${table.availableMs}::bigint + ${table.unavailableMs} + ${table.unknownMs} + ${table.excludedMs} <= 86400000`,
    ),
  ],
);

export const projects = pgTable(
  'projects',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id').notNull(),
    name: varchar('name', { length: 120 }).notNull(),
    slug: varchar('slug', { length: 63 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('projects_identity_unique').on(table.id, table.organizationId),
    unique('projects_organization_slug_unique').on(table.organizationId, table.slug),
    index('projects_organization_created_idx').on(table.organizationId, table.createdAt, table.id),
    check('projects_name_not_blank', sql`length(btrim(${table.name})) > 0`),
    check(
      'projects_slug_format',
      sql`${table.slug} ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and length(${table.slug}) between 2 and 63`,
    ),
  ],
);

export const monitors = pgTable(
  'monitors',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id').notNull(),
    projectId: uuid('project_id').notNull(),

    name: varchar('name', { length: 120 }).notNull(),

    // Current projection.
    //
    // Execution never trusts these values directly. A round references an
    // immutable monitor_configuration_versions row.
    url: text('url').notNull(),
    method: httpMethodEnum('method').notNull().default('GET'),
    lifecycleState: monitorLifecycleEnum('lifecycle_state').notNull().default('ENABLED'),
    timeoutMs: integer('timeout_ms').notNull().default(10_000),
    intervalSeconds: integer('interval_seconds').notNull().default(60),
    nextCheckAt: timestamp('next_check_at', { withTimezone: true }),
    followRedirects: boolean('follow_redirects').notNull().default(true),
    statusPolicy: jsonb('status_policy')
      .$type<HttpStatusPolicy>()
      .notNull()
      .default({ type: 'ANY_2XX' }),
    requestHeaders: jsonb('request_headers').$type<StoredRequestHeader[]>().notNull().default([]),
    requestBody: jsonb('request_body').$type<HttpRequestBody>().notNull().default({ type: 'NONE' }),
    assertions: jsonb('assertions')
      .$type<ResponseAssertionConfigurationV1>()
      .notNull()
      .default(EMPTY_ASSERTION_CONFIGURATION),
    tlsPolicy: jsonb('tls_policy')
      .$type<TlsCertificatePolicy>()
      .notNull()
      .default({ type: 'DISABLED' }),
    locations: jsonb('locations').$type<string[]>().notNull().default(['local']),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),

    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('monitors_id_organization_unique').on(table.id, table.organizationId),

    foreignKey({
      name: 'monitors_project_fk',
      columns: [table.projectId, table.organizationId],
      foreignColumns: [projects.id, projects.organizationId],
    }),

    index('monitors_project_created_idx').on(
      table.organizationId,
      table.projectId,
      table.createdAt,
    ),

    check('monitors_name_not_blank', sql`length(btrim(${table.name})) > 0`),

    check('monitors_url_length', sql`length(${table.url}) <= 2048`),

    check('monitors_timeout_range', sql`${table.timeoutMs} between 1000 and 30000`),
    check('monitors_interval_range', sql`${table.intervalSeconds} between 60 and 86400`),
    check(
      'monitors_lifecycle_schedule_consistent',
      sql`(
        (${table.lifecycleState} = 'ENABLED' and ${table.nextCheckAt} is not null)
        or
        (${table.lifecycleState} in ('PAUSED', 'ARCHIVED') and ${table.nextCheckAt} is null)
      )`,
    ),
    index('monitors_due_enabled_idx')
      .on(table.nextCheckAt, table.id)
      .where(sql`${table.lifecycleState} = 'ENABLED'`),

    check(
      'monitors_status_policy_shape',
      sql`
        jsonb_typeof(${table.statusPolicy}) = 'object'
        and ${table.statusPolicy}->>'type' in ('ANY_2XX', 'EXACT')
        and (
          ${table.statusPolicy}->>'type' = 'ANY_2XX'
          or (
            jsonb_typeof(${table.statusPolicy}->'statusCodes') = 'array'
            and jsonb_array_length(${table.statusPolicy}->'statusCodes') > 0
            and not jsonb_path_exists(
              ${table.statusPolicy},
              '$.statusCodes[*] ? (@.type() != "number" || @ != @.floor() || @ < 100 || @ > 599)'
            )
          )
        )
      `,
    ),

    check(
      'monitors_locations_non_empty',
      sql`watchrail_location_snapshot_is_valid(${table.locations})`,
    ),
    check('monitors_request_headers_array', sql`jsonb_typeof(${table.requestHeaders}) = 'array'`),
    check('monitors_request_body_object', sql`jsonb_typeof(${table.requestBody}) = 'object'`),
    check('monitors_assertions_object', sql`jsonb_typeof(${table.assertions}) = 'object'`),
  ],
);

export const statusPages = pgTable(
  'status_pages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id').notNull(),
    projectId: uuid('project_id').notNull(),
    name: varchar('name', { length: 100 }).notNull(),
    logoUrl: text('logo_url'),
    slug: varchar('slug', { length: 63 }).notNull(),
    published: boolean('published').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('status_pages_identity_unique').on(table.id, table.organizationId),
    foreignKey({
      name: 'status_pages_project_fk',
      columns: [table.projectId, table.organizationId],
      foreignColumns: [projects.id, projects.organizationId],
    }),
    unique('status_pages_slug_unique').on(table.slug),
    index('status_pages_project_created_idx').on(
      table.organizationId,
      table.projectId,
      table.createdAt,
      table.id,
    ),
    check('status_pages_name_not_blank', sql`length(btrim(${table.name})) > 0`),
    check(
      'status_pages_slug_format',
      sql`${table.slug} ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and length(${table.slug}) between 3 and 63`,
    ),
  ],
);

export const statusPageComponents = pgTable(
  'status_page_components',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id').notNull(),
    statusPageId: uuid('status_page_id').notNull(),
    monitorId: uuid('monitor_id').notNull(),
    displayName: varchar('display_name', { length: 100 }).notNull(),
    groupName: varchar('group_name', { length: 100 }),
    position: integer('position').notNull(),
  },
  (table) => [
    foreignKey({
      name: 'status_page_components_page_fk',
      columns: [table.statusPageId, table.organizationId],
      foreignColumns: [statusPages.id, statusPages.organizationId],
    }).onDelete('cascade'),
    foreignKey({
      name: 'status_page_components_monitor_fk',
      columns: [table.monitorId, table.organizationId],
      foreignColumns: [monitors.id, monitors.organizationId],
    }),
    unique('status_page_components_page_monitor_unique').on(table.statusPageId, table.monitorId),
    unique('status_page_components_page_position_unique').on(table.statusPageId, table.position),
    index('status_page_components_page_order_idx').on(table.statusPageId, table.position),
    check(
      'status_page_components_display_name_not_blank',
      sql`length(btrim(${table.displayName})) > 0`,
    ),
    check(
      'status_page_components_group_name_not_blank',
      sql`${table.groupName} is null or length(btrim(${table.groupName})) > 0`,
    ),
    check('status_page_components_position_non_negative', sql`${table.position} >= 0`),
  ],
);

export const monitorConfigurationVersions = pgTable(
  'monitor_configuration_versions',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    organizationId: uuid('organization_id').notNull(),
    monitorId: uuid('monitor_id').notNull(),

    versionNumber: integer('version_number').notNull(),

    url: text('url').notNull(),
    method: httpMethodEnum('method').notNull(),
    timeoutMs: integer('timeout_ms').notNull(),
    intervalSeconds: integer('interval_seconds').notNull().default(60),
    followRedirects: boolean('follow_redirects').notNull().default(true),
    statusPolicy: jsonb('status_policy')
      .$type<HttpStatusPolicy>()
      .notNull()
      .default({ type: 'ANY_2XX' }),
    requestHeaders: jsonb('request_headers').$type<StoredRequestHeader[]>().notNull().default([]),
    requestBody: jsonb('request_body').$type<HttpRequestBody>().notNull().default({ type: 'NONE' }),
    assertions: jsonb('assertions')
      .$type<ResponseAssertionConfigurationV1>()
      .notNull()
      .default(EMPTY_ASSERTION_CONFIGURATION),
    tlsPolicy: jsonb('tls_policy')
      .$type<TlsCertificatePolicy>()
      .notNull()
      .default({ type: 'DISABLED' }),

    locations: jsonb('locations').$type<string[]>().notNull(),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      name: 'monitor_configuration_versions_monitor_fk',
      columns: [table.monitorId, table.organizationId],
      foreignColumns: [monitors.id, monitors.organizationId],
    }).onDelete('cascade'),

    unique('monitor_configuration_versions_monitor_version_unique').on(
      table.monitorId,
      table.versionNumber,
    ),

    // Allows a round to reference a version while also proving that
    // organization + monitor + version all belong together.
    unique('monitor_configuration_versions_identity_unique').on(
      table.id,
      table.organizationId,
      table.monitorId,
    ),

    index('monitor_configuration_versions_latest_idx').on(
      table.organizationId,
      table.monitorId,
      table.versionNumber,
    ),

    check('monitor_configuration_versions_version_positive', sql`${table.versionNumber} > 0`),

    check('monitor_configuration_versions_url_length', sql`length(${table.url}) <= 2048`),

    check(
      'monitor_configuration_versions_timeout_range',
      sql`${table.timeoutMs} between 1000 and 30000`,
    ),

    check(
      'monitor_configuration_versions_status_policy_shape',
      sql`
        jsonb_typeof(${table.statusPolicy}) = 'object'
        and ${table.statusPolicy}->>'type' in ('ANY_2XX', 'EXACT')
        and (
          ${table.statusPolicy}->>'type' = 'ANY_2XX'
          or (
            jsonb_typeof(${table.statusPolicy}->'statusCodes') = 'array'
            and jsonb_array_length(${table.statusPolicy}->'statusCodes') > 0
            and not jsonb_path_exists(
              ${table.statusPolicy},
              '$.statusCodes[*] ? (@.type() != "number" || @ != @.floor() || @ < 100 || @ > 599)'
            )
          )
        )
      `,
    ),
    check(
      'monitor_configuration_versions_interval_range',
      sql`${table.intervalSeconds} between 60 and 86400`,
    ),

    check(
      'monitor_configuration_versions_locations_non_empty',
      sql`watchrail_location_snapshot_is_valid(${table.locations})`,
    ),
    check(
      'monitor_configuration_versions_request_headers_array',
      sql`jsonb_typeof(${table.requestHeaders}) = 'array'`,
    ),
    check(
      'monitor_configuration_versions_request_body_object',
      sql`jsonb_typeof(${table.requestBody}) = 'object'`,
    ),
    check(
      'monitor_configuration_versions_assertions_object',
      sql`jsonb_typeof(${table.assertions}) = 'object'`,
    ),
  ],
);

export const checkRounds = pgTable(
  'check_rounds',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    organizationId: uuid('organization_id').notNull(),
    monitorId: uuid('monitor_id').notNull(),

    monitorConfigurationVersionId: uuid('monitor_configuration_version_id').notNull(),

    trigger: checkRoundTriggerEnum('trigger').notNull().default('MANUAL'),

    status: checkRoundStatusEnum('status').notNull().default('PENDING'),

    contractVersion: integer('contract_version').notNull().default(1),
    aggregationPolicyVersion: integer('aggregation_policy_version').notNull().default(1),
    confirmationPolicyVersion: integer('confirmation_policy_version').notNull().default(1),
    finalizationDeadlineAt: timestamp('finalization_deadline_at', { withTimezone: true })
      .notNull()
      .default(sql`clock_timestamp() + interval '120 seconds'`),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      name: 'check_rounds_monitor_fk',
      columns: [table.monitorId, table.organizationId],
      foreignColumns: [monitors.id, monitors.organizationId],
    }),

    foreignKey({
      name: 'check_rounds_configuration_version_fk',
      columns: [table.monitorConfigurationVersionId, table.organizationId, table.monitorId],
      foreignColumns: [
        monitorConfigurationVersions.id,
        monitorConfigurationVersions.organizationId,
        monitorConfigurationVersions.monitorId,
      ],
    }),

    unique('check_rounds_organization_id_unique').on(table.organizationId, table.id),

    check('check_rounds_contract_version_supported', sql`${table.contractVersion} = 1`),
    check(
      'check_rounds_aggregation_policy_version_supported',
      sql`${table.aggregationPolicyVersion} = 1`,
    ),
    check(
      'check_rounds_confirmation_policy_version_supported',
      sql`${table.confirmationPolicyVersion} = 1`,
    ),
    check(
      'check_rounds_finalization_deadline_after_creation',
      sql`${table.finalizationDeadlineAt} > ${table.createdAt}`,
    ),

    index('check_rounds_monitor_created_idx').on(
      table.organizationId,
      table.monitorId,
      table.createdAt,
      table.id,
    ),
  ],
);

export const checkRoundLocations = pgTable(
  'check_round_locations',
  {
    organizationId: uuid('organization_id').notNull(),
    roundId: uuid('round_id').notNull(),
    location: varchar('location', { length: 64 }).notNull(),
    probeLocationId: uuid('probe_location_id'),
    position: integer('position').notNull(),
  },
  (table) => [
    primaryKey({
      name: 'check_round_locations_pk',
      columns: [table.organizationId, table.roundId, table.location],
    }),
    unique('check_round_locations_round_position_unique').on(
      table.organizationId,
      table.roundId,
      table.position,
    ),
    foreignKey({
      name: 'check_round_locations_round_fk',
      columns: [table.organizationId, table.roundId],
      foreignColumns: [checkRounds.organizationId, checkRounds.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'check_round_locations_probe_location_fk',
      columns: [table.organizationId, table.probeLocationId],
      foreignColumns: [probeLocations.organizationId, probeLocations.id],
    }),
    check('check_round_locations_position_non_negative', sql`${table.position} >= 0`),
    check(
      'check_round_locations_identity_consistent',
      sql`(
        (${table.location} = 'local' and ${table.probeLocationId} is null)
        or
        (${table.probeLocationId} is not null and ${table.location} = ${table.probeLocationId}::text)
      )`,
    ),
  ],
);

export const checkExecutionAssignments = pgTable(
  'check_execution_assignments',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    organizationId: uuid('organization_id').notNull(),
    roundId: uuid('round_id').notNull(),

    location: varchar('location', { length: 64 }).notNull().default('local'),
    probeLocationId: uuid('probe_location_id'),
    executionPolicyVersion: varchar('execution_policy_version', { length: 64 })
      .notNull()
      .default(HTTP_EXECUTION_POLICY_VERSION),
    requiredEngineVersion: varchar('required_engine_version', { length: 64 })
      .notNull()
      .default(HTTP_ENGINE_VERSION),

    status: executionAssignmentStatusEnum('status').notNull().default('PENDING'),

    claimToken: uuid('claim_token'),
    claimExpiresAt: timestamp('claim_expires_at', { withTimezone: true }),
    pendingSince: timestamp('pending_since', { withTimezone: true }).notNull().defaultNow(),
    attemptCount: integer('attempt_count').notNull().default(0),
    lastStartedAt: timestamp('last_started_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      name: 'check_execution_assignments_round_fk',
      columns: [table.organizationId, table.roundId],
      foreignColumns: [checkRounds.organizationId, checkRounds.id],
    }).onDelete('cascade'),

    foreignKey({
      name: 'check_execution_assignments_round_location_fk',
      columns: [table.organizationId, table.roundId, table.location],
      foreignColumns: [
        checkRoundLocations.organizationId,
        checkRoundLocations.roundId,
        checkRoundLocations.location,
      ],
    }).onDelete('cascade'),

    foreignKey({
      name: 'check_execution_assignments_probe_location_fk',
      columns: [table.organizationId, table.probeLocationId],
      foreignColumns: [probeLocations.organizationId, probeLocations.id],
    }),

    unique('check_execution_assignments_round_location_unique').on(table.roundId, table.location),

    unique('check_execution_assignments_identity_unique').on(
      table.organizationId,
      table.roundId,
      table.id,
    ),
    unique('check_execution_assignments_regional_identity_unique').on(
      table.organizationId,
      table.roundId,
      table.id,
      table.location,
    ),
    unique('check_execution_assignments_organization_id_unique').on(table.organizationId, table.id),
    unique('check_execution_assignments_location_identity_unique').on(
      table.organizationId,
      table.id,
      table.probeLocationId,
    ),

    check(
      'check_execution_assignments_location_consistent',
      sql`(
        (${table.location} = 'local' and ${table.probeLocationId} is null)
        or
        (${table.probeLocationId} is not null and ${table.location} = ${table.probeLocationId}::text)
      )`,
    ),
    check(
      'check_execution_assignments_policy_version_format',
      sql`${table.executionPolicyVersion} ~ '^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$'`,
    ),
    check(
      'check_execution_assignments_engine_version_format',
      sql`${table.requiredEngineVersion} ~ '^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$'`,
    ),

    check(
      'check_execution_assignments_attempt_count_non_negative',
      sql`${table.attemptCount} >= 0`,
    ),

    check(
      'check_execution_assignments_claim_consistent',
      sql`
        (${table.status} = 'RUNNING') =
        (${table.claimToken} is not null and ${table.claimExpiresAt} is not null)
      `,
    ),

    check(
      'check_execution_assignments_completion_consistent',
      sql`(${table.status} = 'COMPLETED') = (${table.completedAt} is not null)`,
    ),
  ],
);

export const probeExecutionAttempts = pgTable(
  'probe_execution_attempts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id').notNull(),
    assignmentId: uuid('assignment_id').notNull(),
    locationId: uuid('location_id').notNull(),
    agentId: uuid('agent_id').notNull(),
    attemptNumber: integer('attempt_number').notNull(),
    claimTokenVerifier: varchar('claim_token_verifier', { length: 43 }).notNull(),
    status: probeAttemptStatusEnum('status').notNull().default('LEASED'),
    leasedAt: timestamp('leased_at', { withTimezone: true }).notNull().defaultNow(),
    leaseExpiresAt: timestamp('lease_expires_at', { withTimezone: true }).notNull(),
    submittedAt: timestamp('submitted_at', { withTimezone: true }),
    terminalReason: varchar('terminal_reason', { length: 64 }),
    submittedEngineVersion: varchar('submitted_engine_version', { length: 64 }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('probe_execution_attempts_identity_unique').on(table.organizationId, table.id),
    unique('probe_execution_attempts_number_unique').on(
      table.organizationId,
      table.assignmentId,
      table.attemptNumber,
    ),
    unique('probe_execution_attempts_claim_verifier_unique').on(table.claimTokenVerifier),
    foreignKey({
      name: 'probe_execution_attempts_assignment_fk',
      columns: [table.organizationId, table.assignmentId, table.locationId],
      foreignColumns: [
        checkExecutionAssignments.organizationId,
        checkExecutionAssignments.id,
        checkExecutionAssignments.probeLocationId,
      ],
    }).onDelete('cascade'),
    foreignKey({
      name: 'probe_execution_attempts_agent_fk',
      columns: [table.organizationId, table.agentId, table.locationId],
      foreignColumns: [probeAgents.organizationId, probeAgents.id, probeAgents.locationId],
    }),
    check('probe_execution_attempts_number_positive', sql`${table.attemptNumber} > 0`),
    check(
      'probe_execution_attempts_claim_verifier_format',
      sql`${table.claimTokenVerifier} ~ '^[A-Za-z0-9_-]{43}$'`,
    ),
    check('probe_execution_attempts_lease_order', sql`${table.leaseExpiresAt} > ${table.leasedAt}`),
    check(
      'probe_execution_attempts_submission_consistent',
      sql`(${table.status} = 'SUBMITTED') = (${table.submittedAt} is not null and ${table.submittedEngineVersion} is not null)`,
    ),
    check(
      'probe_execution_attempts_terminal_reason_consistent',
      sql`(${table.status} in ('EXPIRED', 'REJECTED')) = (${table.terminalReason} is not null)`,
    ),
    index('probe_execution_attempts_assignment_idx').on(
      table.organizationId,
      table.assignmentId,
      table.attemptNumber,
    ),
    index('probe_execution_attempts_lease_idx').on(table.status, table.leaseExpiresAt, table.id),
    uniqueIndex('probe_execution_attempts_one_leased_unique')
      .on(table.organizationId, table.assignmentId)
      .where(sql`${table.status} = 'LEASED'`),
  ],
);

export const checkExecutionResults = pgTable(
  'check_execution_results',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    organizationId: uuid('organization_id').notNull(),
    roundId: uuid('round_id').notNull(),
    assignmentId: uuid('assignment_id').notNull(),

    outcome: checkResultOutcomeEnum('outcome').notNull(),
    stage: checkResultStageEnum('stage').notNull(),
    reason: checkResultReasonEnum('reason').notNull(),

    statusCode: integer('status_code'),
    responseTimeMs: doublePrecision('response_time_ms'),
    attemptDurationMs: doublePrecision('attempt_duration_ms').notNull(),
    redirects: jsonb('redirects').$type<HttpRedirectHop[]>().notNull().default([]),
    assertionEvaluation: jsonb('assertion_evaluation')
      .$type<AssertionEvaluationV1>()
      .notNull()
      .default(EMPTY_ASSERTION_EVALUATION),
    tlsCertificates: jsonb('tls_certificates')
      .$type<TlsCertificateEvidenceV1[]>()
      .notNull()
      .default([]),
    checkedAt: timestamp('checked_at', { withTimezone: true }).notNull(),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      name: 'check_execution_results_assignment_fk',
      columns: [table.organizationId, table.roundId, table.assignmentId],
      foreignColumns: [
        checkExecutionAssignments.organizationId,
        checkExecutionAssignments.roundId,
        checkExecutionAssignments.id,
      ],
    }).onDelete('cascade'),

    unique('check_execution_results_assignment_unique').on(table.assignmentId),

    index('check_execution_results_round_idx').on(
      table.organizationId,
      table.roundId,
      table.checkedAt,
    ),

    check(
      'check_execution_results_status_code_range',
      sql`${table.statusCode} is null or ${table.statusCode} between 100 and 599`,
    ),

    check(
      'check_execution_results_response_evidence_consistent',
      sql`(${table.statusCode} is null) = (${table.responseTimeMs} is null)`,
    ),

    check(
      'check_execution_results_response_time_non_negative',
      sql`${table.responseTimeMs} is null or ${table.responseTimeMs} >= 0`,
    ),

    check(
      'check_execution_results_attempt_duration_non_negative',
      sql`${table.attemptDurationMs} >= 0`,
    ),
    check(
      'check_execution_results_redirects_array',
      sql`jsonb_typeof(${table.redirects}) = 'array'`,
    ),
    check(
      'check_execution_results_assertion_evaluation_object',
      sql`jsonb_typeof(${table.assertionEvaluation}) = 'object'`,
    ),
    check(
      'check_execution_results_tls_certificates_array',
      sql`jsonb_typeof(${table.tlsCertificates}) = 'array'`,
    ),
  ],
);

export const checkRegionalExecutions = pgTable(
  'check_regional_executions',
  {
    id: uuid('id').primaryKey(),
    organizationId: uuid('organization_id').notNull(),
    roundId: uuid('round_id').notNull(),
    assignmentId: uuid('assignment_id').notNull(),
    location: varchar('location', { length: 64 }).notNull(),
    agentId: varchar('agent_id', { length: 128 }).notNull(),
    role: varchar('role', { length: 16 }).notNull(),
    observation: jsonb('observation').$type<ProbeObservationV1>().notNull(),
    diagnosticSummary: jsonb('diagnostic_summary').$type<RegionalDiagnosticSummary>(),
    resultDigest: varchar('result_digest', { length: 64 }),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      name: 'check_regional_executions_assignment_fk',
      columns: [table.organizationId, table.roundId, table.assignmentId, table.location],
      foreignColumns: [
        checkExecutionAssignments.organizationId,
        checkExecutionAssignments.roundId,
        checkExecutionAssignments.id,
        checkExecutionAssignments.location,
      ],
    }).onDelete('cascade'),
    foreignKey({
      name: 'check_regional_executions_round_location_fk',
      columns: [table.organizationId, table.roundId, table.location],
      foreignColumns: [
        checkRoundLocations.organizationId,
        checkRoundLocations.roundId,
        checkRoundLocations.location,
      ],
    }).onDelete('cascade'),
    unique('check_regional_executions_identity_unique').on(
      table.organizationId,
      table.roundId,
      table.location,
      table.id,
    ),
    unique('check_regional_executions_role_unique').on(
      table.organizationId,
      table.roundId,
      table.location,
      table.role,
    ),
    check(
      'check_regional_executions_role_valid',
      sql`${table.role} in ('PRIMARY', 'CONFIRMATION')`,
    ),
    check(
      'check_regional_executions_observation_object',
      sql`jsonb_typeof(${table.observation}) = 'object'`,
    ),
    check(
      'check_regional_executions_diagnostic_summary_object',
      sql`${table.diagnosticSummary} is null or jsonb_typeof(${table.diagnosticSummary}) = 'object'`,
    ),
    check(
      'check_regional_executions_result_digest_format',
      sql`${table.resultDigest} is null or ${table.resultDigest} ~ '^[0-9a-f]{64}$'`,
    ),
  ],
);

export interface RegionalDiagnosticSummary {
  stage: 'DNS' | 'CONNECT' | 'TLS' | 'HTTP' | 'PROBE';
  reason: string;
  statusCode: number | null;
  responseTimeMs: number | null;
  attemptDurationMs: number;
  checkedAt: string;
  assertionEvaluation?: AssertionEvaluationV1;
  tlsCertificates?: TlsCertificateEvidenceV1[];
}

export const checkRegionalEvaluations = pgTable(
  'check_regional_evaluations',
  {
    organizationId: uuid('organization_id').notNull(),
    roundId: uuid('round_id').notNull(),
    location: varchar('location', { length: 64 }).notNull(),
    phase: varchar('phase', { length: 32 }).notNull().default('AWAITING_PRIMARY'),
    outcome: varchar('outcome', { length: 32 }),
    terminalReason: varchar('terminal_reason', { length: 32 }),
    primaryExecutionId: uuid('primary_execution_id'),
    confirmationExecutionId: uuid('confirmation_execution_id'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({
      name: 'check_regional_evaluations_pk',
      columns: [table.organizationId, table.roundId, table.location],
    }),
    foreignKey({
      name: 'check_regional_evaluations_round_location_fk',
      columns: [table.organizationId, table.roundId, table.location],
      foreignColumns: [
        checkRoundLocations.organizationId,
        checkRoundLocations.roundId,
        checkRoundLocations.location,
      ],
    }).onDelete('cascade'),
    foreignKey({
      name: 'check_regional_evaluations_primary_execution_fk',
      columns: [table.organizationId, table.roundId, table.location, table.primaryExecutionId],
      foreignColumns: [
        checkRegionalExecutions.organizationId,
        checkRegionalExecutions.roundId,
        checkRegionalExecutions.location,
        checkRegionalExecutions.id,
      ],
    }),
    foreignKey({
      name: 'check_regional_evaluations_confirmation_execution_fk',
      columns: [table.organizationId, table.roundId, table.location, table.confirmationExecutionId],
      foreignColumns: [
        checkRegionalExecutions.organizationId,
        checkRegionalExecutions.roundId,
        checkRegionalExecutions.location,
        checkRegionalExecutions.id,
      ],
    }),
    check(
      'check_regional_evaluations_phase_valid',
      sql`${table.phase} in ('AWAITING_PRIMARY', 'AWAITING_CONFIRMATION', 'TERMINAL')`,
    ),
    check(
      'check_regional_evaluations_outcome_valid',
      sql`${table.outcome} is null or ${table.outcome} in ('PASS', 'CONFIRMED_FAIL', 'UNKNOWN')`,
    ),
    check(
      'check_regional_evaluations_terminal_consistent',
      sql`(${table.phase} = 'TERMINAL') = (${table.outcome} is not null and ${table.terminalReason} is not null)`,
    ),
  ],
);

export const checkRoundAggregates = pgTable(
  'check_round_aggregates',
  {
    organizationId: uuid('organization_id').notNull(),
    roundId: uuid('round_id').notNull(),
    outcome: varchar('outcome', { length: 16 }).notNull(),
    aggregate: jsonb('aggregate').$type<AggregateRoundDecisionV1>().notNull(),
    finalizedAt: timestamp('finalized_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({
      name: 'check_round_aggregates_pk',
      columns: [table.organizationId, table.roundId],
    }),
    foreignKey({
      name: 'check_round_aggregates_round_fk',
      columns: [table.organizationId, table.roundId],
      foreignColumns: [checkRounds.organizationId, checkRounds.id],
    }).onDelete('cascade'),
    check(
      'check_round_aggregates_outcome_valid',
      sql`${table.outcome} in ('UP', 'DEGRADED', 'DOWN', 'UNKNOWN')`,
    ),
    check(
      'check_round_aggregates_payload_object',
      sql`jsonb_typeof(${table.aggregate}) = 'object'`,
    ),
  ],
);

export const monitorIncidentState = pgTable(
  'monitor_incident_state',
  {
    organizationId: uuid('organization_id').notNull(),
    monitorId: uuid('monitor_id').primaryKey(),
    consecutiveFailures: integer('consecutive_failures').notNull().default(0),
    failureStreakStartedAt: timestamp('failure_streak_started_at', { withTimezone: true }),
    failureStreakStartedRoundId: uuid('failure_streak_started_round_id'),
    multiLocationSeverity: varchar('multi_location_severity', { length: 16 }),
    multiLocationHealthyRecoveryStreak: integer('multi_location_healthy_recovery_streak')
      .notNull()
      .default(0),
    lastProcessedRoundCreatedAt: timestamp('last_processed_round_created_at', {
      withTimezone: true,
    }),
    lastProcessedRoundId: uuid('last_processed_round_id'),
    trackingStartedAt: timestamp('tracking_started_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      name: 'monitor_incident_state_monitor_fk',
      columns: [table.monitorId, table.organizationId],
      foreignColumns: [monitors.id, monitors.organizationId],
    }).onDelete('cascade'),
    unique('monitor_incident_state_identity_unique').on(table.organizationId, table.monitorId),
    check('monitor_incident_state_failures_non_negative', sql`${table.consecutiveFailures} >= 0`),
    check(
      'monitor_incident_state_streak_consistent',
      sql`(${table.consecutiveFailures} = 0) = (${table.failureStreakStartedAt} is null and ${table.failureStreakStartedRoundId} is null)`,
    ),
    check(
      'monitor_incident_state_last_processed_consistent',
      sql`(${table.lastProcessedRoundCreatedAt} is null) = (${table.lastProcessedRoundId} is null)`,
    ),
    check(
      'monitor_incident_state_multi_location_severity_valid',
      sql`${table.multiLocationSeverity} is null or ${table.multiLocationSeverity} in ('DEGRADED', 'DOWN')`,
    ),
    check(
      'monitor_incident_state_multi_location_recovery_valid',
      sql`${table.multiLocationHealthyRecoveryStreak} between 0 and 1 and (${table.multiLocationSeverity} is not null or ${table.multiLocationHealthyRecoveryStreak} = 0)`,
    ),
  ],
);

export const incidents = pgTable(
  'incidents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id').notNull(),
    monitorId: uuid('monitor_id').notNull(),
    status: incidentStatusEnum('status').notNull().default('OPEN'),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
    openedAt: timestamp('opened_at', { withTimezone: true }).notNull(),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    startedByRoundId: uuid('started_by_round_id').notNull(),
    openedByRoundId: uuid('opened_by_round_id').notNull(),
    resolvedByRoundId: uuid('resolved_by_round_id'),
    severity: varchar('severity', { length: 16 }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      name: 'incidents_monitor_fk',
      columns: [table.monitorId, table.organizationId],
      foreignColumns: [monitors.id, monitors.organizationId],
    }).onDelete('cascade'),
    foreignKey({
      name: 'incidents_started_round_fk',
      columns: [table.organizationId, table.startedByRoundId],
      foreignColumns: [checkRounds.organizationId, checkRounds.id],
    }),
    foreignKey({
      name: 'incidents_opened_round_fk',
      columns: [table.organizationId, table.openedByRoundId],
      foreignColumns: [checkRounds.organizationId, checkRounds.id],
    }),
    foreignKey({
      name: 'incidents_resolved_round_fk',
      columns: [table.organizationId, table.resolvedByRoundId],
      foreignColumns: [checkRounds.organizationId, checkRounds.id],
    }),
    unique('incidents_identity_unique').on(table.organizationId, table.id),
    uniqueIndex('incidents_monitor_open_unique')
      .on(table.organizationId, table.monitorId)
      .where(sql`${table.status} = 'OPEN'`),
    index('incidents_monitor_opened_idx').on(
      table.organizationId,
      table.monitorId,
      table.openedAt,
      table.id,
    ),
    check(
      'incidents_resolution_consistent',
      sql`(${table.status} = 'RESOLVED') = (${table.resolvedAt} is not null and ${table.resolvedByRoundId} is not null)`,
    ),
    check(
      'incidents_severity_valid',
      sql`${table.severity} is null or ${table.severity} in ('DEGRADED', 'DOWN')`,
    ),
  ],
);

export const webhookEndpoints = pgTable(
  'webhook_endpoints',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id').notNull(),
    name: varchar('name', { length: 120 }).notNull(),
    enabled: boolean('enabled').notNull().default(true),
    currentVersionNumber: integer('current_version_number').notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('webhook_endpoints_identity_unique').on(table.organizationId, table.id),
    check('webhook_endpoints_name_not_blank', sql`length(btrim(${table.name})) > 0`),
    check('webhook_endpoints_version_positive', sql`${table.currentVersionNumber} > 0`),
  ],
);

export const webhookEndpointVersions = pgTable(
  'webhook_endpoint_versions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id').notNull(),
    endpointId: uuid('endpoint_id').notNull(),
    versionNumber: integer('version_number').notNull(),
    url: text('url').notNull(),
    signingSecretEnvelope: jsonb('signing_secret_envelope')
      .$type<EncryptedWebhookSigningSecretV1>()
      .notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      name: 'webhook_endpoint_versions_endpoint_fk',
      columns: [table.organizationId, table.endpointId],
      foreignColumns: [webhookEndpoints.organizationId, webhookEndpoints.id],
    }).onDelete('cascade'),
    unique('webhook_endpoint_versions_identity_unique').on(
      table.organizationId,
      table.endpointId,
      table.id,
    ),
    unique('webhook_endpoint_versions_number_unique').on(
      table.organizationId,
      table.endpointId,
      table.versionNumber,
    ),
    check('webhook_endpoint_versions_version_positive', sql`${table.versionNumber} > 0`),
    check('webhook_endpoint_versions_url_length', sql`length(${table.url}) between 1 and 2048`),
    check(
      'webhook_endpoint_versions_secret_object',
      sql`jsonb_typeof(${table.signingSecretEnvelope}) = 'object'`,
    ),
  ],
);

export const notificationEvents = pgTable(
  'notification_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id').notNull(),
    monitorId: uuid('monitor_id').notNull(),
    incidentId: uuid('incident_id').notNull(),
    eventType: notificationEventTypeEnum('event_type').notNull(),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
    triggeringRoundId: uuid('triggering_round_id').notNull(),
    payload: jsonb('payload').$type<WebhookNotificationV1>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('notification_events_identity_unique').on(table.organizationId, table.id),
    unique('notification_events_incident_type_unique').on(
      table.organizationId,
      table.incidentId,
      table.eventType,
    ),
    foreignKey({
      name: 'notification_events_monitor_fk',
      columns: [table.monitorId, table.organizationId],
      foreignColumns: [monitors.id, monitors.organizationId],
    }).onDelete('cascade'),
    foreignKey({
      name: 'notification_events_incident_fk',
      columns: [table.organizationId, table.incidentId],
      foreignColumns: [incidents.organizationId, incidents.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'notification_events_round_fk',
      columns: [table.organizationId, table.triggeringRoundId],
      foreignColumns: [checkRounds.organizationId, checkRounds.id],
    }),
    check(
      'notification_events_payload_contract',
      sql`jsonb_typeof(${table.payload}) = 'object' and ${table.payload}->>'contractVersion' = '1' and ${table.payload}->>'eventId' = ${table.id}::text and ${table.payload}->>'organizationId' = ${table.organizationId}::text and ${table.payload}->>'eventType' = ${table.eventType}::text and ${table.payload}->>'triggeringRoundId' = ${table.triggeringRoundId}::text`,
    ),
  ],
);

export const notificationDeliveries = pgTable(
  'notification_deliveries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id').notNull(),
    eventId: uuid('event_id').notNull(),
    endpointId: uuid('endpoint_id').notNull(),
    endpointVersionId: uuid('endpoint_version_id').notNull(),
    availableAt: timestamp('available_at', { withTimezone: true }).notNull().defaultNow(),
    claimToken: uuid('claim_token'),
    attemptCount: integer('attempt_count').notNull().default(0),
    lastAttemptAt: timestamp('last_attempt_at', { withTimezone: true }),
    lastErrorCode: varchar('last_error_code', { length: 64 }),
    lastHttpStatus: integer('last_http_status'),
    deliveredAt: timestamp('delivered_at', { withTimezone: true }),
    deadAt: timestamp('dead_at', { withTimezone: true }),
    deadReason: varchar('dead_reason', { length: 64 }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('notification_deliveries_event_endpoint_unique').on(
      table.organizationId,
      table.eventId,
      table.endpointId,
    ),
    foreignKey({
      name: 'notification_deliveries_event_fk',
      columns: [table.organizationId, table.eventId],
      foreignColumns: [notificationEvents.organizationId, notificationEvents.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'notification_deliveries_endpoint_fk',
      columns: [table.organizationId, table.endpointId],
      foreignColumns: [webhookEndpoints.organizationId, webhookEndpoints.id],
    }),
    foreignKey({
      name: 'notification_deliveries_endpoint_version_fk',
      columns: [table.organizationId, table.endpointId, table.endpointVersionId],
      foreignColumns: [
        webhookEndpointVersions.organizationId,
        webhookEndpointVersions.endpointId,
        webhookEndpointVersions.id,
      ],
    }),
    index('notification_deliveries_eligible_idx')
      .on(table.availableAt, table.createdAt, table.id)
      .where(sql`${table.deliveredAt} is null and ${table.deadAt} is null`),
    index('notification_deliveries_endpoint_history_idx').on(
      table.organizationId,
      table.endpointId,
      table.createdAt.desc(),
      table.id.desc(),
    ),
    check('notification_deliveries_attempt_count_non_negative', sql`${table.attemptCount} >= 0`),
    check(
      'notification_deliveries_http_status_range',
      sql`${table.lastHttpStatus} is null or ${table.lastHttpStatus} between 100 and 599`,
    ),
    check(
      'notification_deliveries_one_terminal_state',
      sql`not (${table.deliveredAt} is not null and ${table.deadAt} is not null)`,
    ),
    check(
      'notification_deliveries_dead_fields_consistent',
      sql`(${table.deadAt} is null) = (${table.deadReason} is null)`,
    ),
    check(
      'notification_deliveries_terminal_claim_cleared',
      sql`(${table.deliveredAt} is null and ${table.deadAt} is null) or ${table.claimToken} is null`,
    ),
  ],
);

export const checkRoundOutbox = pgTable(
  'check_round_outbox',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    // Metadata used for DB integrity and relay bookkeeping.
    roundId: uuid('round_id').notNull(),

    // The actual dispatched contract contains exactly these two fields.
    payload: jsonb('payload').$type<ExecuteCheckRoundJobV1>().notNull(),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),

    // The next database-clock instant at which a relay may claim this event.
    // While claimed, this is the lease expiry. After transient failure, it is
    // the retry time.
    availableAt: timestamp('available_at', { withTimezone: true }).notNull().defaultNow(),

    claimToken: uuid('claim_token'),

    // Counts successful relay claims, not queue publication failures.
    attemptCount: integer('attempt_count').notNull().default(0),

    lastAttemptAt: timestamp('last_attempt_at', { withTimezone: true }),

    lastErrorCode: varchar('last_error_code', { length: 64 }),

    blockedAt: timestamp('blocked_at', { withTimezone: true }),

    blockedReason: varchar('blocked_reason', { length: 64 }),

    publishedAt: timestamp('published_at', {
      withTimezone: true,
    }),
  },
  (table) => [
    foreignKey({
      name: 'check_round_outbox_round_fk',
      columns: [table.roundId],
      foreignColumns: [checkRounds.id],
    }).onDelete('cascade'),

    // At most one queue request per round.
    unique('check_round_outbox_round_unique').on(table.roundId),

    index('check_round_outbox_eligible_idx')
      .on(table.availableAt, table.createdAt, table.id)
      .where(sql`${table.publishedAt} is null and ${table.blockedAt} is null`),

    check('check_round_outbox_attempt_count_non_negative', sql`${table.attemptCount} >= 0`),

    check(
      'check_round_outbox_block_fields_consistent',
      sql`(${table.blockedAt} is null) = (${table.blockedReason} is null)`,
    ),

    check(
      'check_round_outbox_not_published_and_blocked',
      sql`not (${table.publishedAt} is not null and ${table.blockedAt} is not null)`,
    ),

    check(
      'check_round_outbox_terminal_claim_cleared',
      sql`(${table.publishedAt} is null and ${table.blockedAt} is null) or ${table.claimToken} is null`,
    ),

    check(
      'check_round_outbox_published_error_cleared',
      sql`${table.publishedAt} is null or ${table.lastErrorCode} is null`,
    ),

    check(
      'check_round_outbox_payload_contract',
      sql`
        jsonb_typeof(${table.payload}) = 'object'
        and ${table.payload}->>'contractVersion' = '1'
        and ${table.payload}->>'roundId' = ${table.roundId}::text
        and (${table.payload} - 'contractVersion' - 'roundId') = '{}'::jsonb
      `,
    ),
  ],
);

export type MonitorRecord = typeof monitors.$inferSelect;
export type NewMonitorRecord = typeof monitors.$inferInsert;
export type ProjectRecord = typeof projects.$inferSelect;
export type NewProjectRecord = typeof projects.$inferInsert;

export type MonitorConfigurationVersionRecord = typeof monitorConfigurationVersions.$inferSelect;

export type NewMonitorConfigurationVersionRecord = typeof monitorConfigurationVersions.$inferInsert;

export type CheckRoundRecord = typeof checkRounds.$inferSelect;
export type CheckRoundLocationRecord = typeof checkRoundLocations.$inferSelect;

export type CheckExecutionAssignmentRecord = typeof checkExecutionAssignments.$inferSelect;

export type CheckExecutionResultRecord = typeof checkExecutionResults.$inferSelect;

export type CheckRoundOutboxRecord = typeof checkRoundOutbox.$inferSelect;

export type ProbeLocationRecord = typeof probeLocations.$inferSelect;
export type ProbeAgentRecord = typeof probeAgents.$inferSelect;
export type ProbeAgentEnrollmentRecord = typeof probeAgentEnrollments.$inferSelect;
export type ProbeAgentCredentialRecord = typeof probeAgentCredentials.$inferSelect;
export type ProbeExecutionAttemptRecord = typeof probeExecutionAttempts.$inferSelect;

// ─── Better Auth tables ───────────────────────────────────────────────────────
// These tables are managed by Better Auth. Do not hand-edit their structure
// without updating the Drizzle migration accordingly.

export const authUser = pgTable('user', {
  id: uuid('id').defaultRandom().primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  emailVerified: boolean('email_verified').notNull().default(false),
  image: text('image'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
});

export const authSession = pgTable('session', {
  id: uuid('id').defaultRandom().primaryKey(),
  expiresAt: timestamp('expires_at').notNull(),
  token: text('token').notNull().unique(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
  ipAddress: text('ip_address'),
  userAgent: text('user_agent'),
  userId: uuid('user_id')
    .notNull()
    .references(() => authUser.id, { onDelete: 'cascade' }),
  activeOrganizationId: uuid('active_organization_id').references(() => authOrganization.id, {
    onDelete: 'set null',
  }),
});

export const authAccount = pgTable(
  'account',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    accountId: text('account_id').notNull(),
    providerId: text('provider_id').notNull(),
    userId: uuid('user_id')
      .notNull()
      .references(() => authUser.id, { onDelete: 'cascade' }),
    accessToken: text('access_token'),
    refreshToken: text('refresh_token'),
    idToken: text('id_token'),
    accessTokenExpiresAt: timestamp('access_token_expires_at'),
    refreshTokenExpiresAt: timestamp('refresh_token_expires_at'),
    scope: text('scope'),
    password: text('password'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
  },
  (table) => [
    unique('account_provider_account_unique').on(table.providerId, table.accountId),
    index('account_user_id_idx').on(table.userId),
  ],
);

export const authVerification = pgTable('verification', {
  id: uuid('id').defaultRandom().primaryKey(),
  identifier: text('identifier').notNull(),
  value: text('value').notNull(),
  expiresAt: timestamp('expires_at').notNull(),
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
});

export const authOrganization = pgTable('organization', {
  id: uuid('id').defaultRandom().primaryKey(),
  name: text('name').notNull(),
  slug: text('slug').unique(),
  logo: text('logo'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  metadata: text('metadata'),
});

export const authMember = pgTable(
  'member',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => authOrganization.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => authUser.id, { onDelete: 'cascade' }),
    role: text('role').notNull().default('viewer'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (table) => [
    unique('member_organization_user_unique').on(table.organizationId, table.userId),
    check('member_role_valid', sql`${table.role} IN ('owner', 'admin', 'editor', 'viewer')`),
  ],
);

export const authInvitation = pgTable('invitation', {
  id: uuid('id').defaultRandom().primaryKey(),
  organizationId: uuid('organization_id')
    .notNull()
    .references(() => authOrganization.id, { onDelete: 'cascade' }),
  email: text('email').notNull(),
  role: text('role'),
  status: text('status').notNull().default('pending'),
  expiresAt: timestamp('expires_at').notNull(),
  inviterId: uuid('inviter_id')
    .notNull()
    .references(() => authUser.id, { onDelete: 'cascade' }),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});

export const authApiKey = pgTable(
  'api_key',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    name: text('name'),
    start: text('start'),
    prefix: text('prefix'),
    key: text('key').notNull().unique(),
    userId: uuid('user_id')
      .notNull()
      .references(() => authUser.id, { onDelete: 'cascade' }),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => authOrganization.id, { onDelete: 'cascade' }),
    refillInterval: integer('refill_interval'),
    refillAmount: integer('refill_amount'),
    lastRefillAt: timestamp('last_refill_at'),
    enabled: boolean('enabled').default(true),
    rateLimitEnabled: boolean('rate_limit_enabled').default(false),
    rateLimitTimeWindow: integer('rate_limit_time_window'),
    rateLimitMax: integer('rate_limit_max'),
    requestCount: integer('request_count').default(0),
    remaining: integer('remaining'),
    lastRequest: timestamp('last_request'),
    expiresAt: timestamp('expires_at'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
    permissions: text('permissions'),
    metadata: text('metadata'),
  },
  (table) => [
    index('api_key_user_idx').on(table.userId),
    index('api_key_organization_idx').on(table.organizationId),
  ],
);

export const authEmailOutbox = pgTable(
  'auth_email_outbox',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    kind: text('kind').notNull(),
    recipientHash: text('recipient_hash').notNull(),
    supersessionKey: text('supersession_key').notNull(),
    encryptedPayload: jsonb('encrypted_payload').notNull(),
    expiresAt: timestamp('expires_at').notNull(),
    availableAt: timestamp('available_at').notNull().defaultNow(),
    claimToken: uuid('claim_token'),
    leaseExpiresAt: timestamp('lease_expires_at'),
    attemptCount: integer('attempt_count').notNull().default(0),
    publishedAt: timestamp('published_at'),
    deliveredAt: timestamp('delivered_at'),
    supersededAt: timestamp('superseded_at'),
    failedAt: timestamp('failed_at'),
    lastErrorCode: text('last_error_code'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (table) => [
    index('auth_email_outbox_eligible_idx')
      .on(table.availableAt, table.id)
      .where(
        sql`${table.publishedAt} IS NULL AND ${table.supersededAt} IS NULL AND ${table.failedAt} IS NULL`,
      ),
    index('auth_email_outbox_supersession_idx').on(table.supersessionKey, table.createdAt),
    check('auth_email_outbox_kind_valid', sql`${table.kind} IN ('OTP', 'INVITATION')`),
    check('auth_email_outbox_attempt_non_negative', sql`${table.attemptCount} >= 0`),
  ],
);

export type AuthUserRecord = typeof authUser.$inferSelect;
export type AuthSessionRecord = typeof authSession.$inferSelect;
export type AuthOrganizationRecord = typeof authOrganization.$inferSelect;
export type AuthMemberRecord = typeof authMember.$inferSelect;
export type AuthInvitationRecord = typeof authInvitation.$inferSelect;
export type AuthApiKeyRecord = typeof authApiKey.$inferSelect;
export type AuthEmailOutboxRecord = typeof authEmailOutbox.$inferSelect;
