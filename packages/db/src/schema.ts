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
  type HttpStatusPolicy,
  type AssertionEvaluationV1,
  type HttpRedirectHop,
  type StoredRequestHeader,
  type ResponseAssertionConfigurationV1,
  EMPTY_ASSERTION_CONFIGURATION,
  EMPTY_ASSERTION_EVALUATION,
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

export const monitors = pgTable(
  'monitors',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id').notNull(),

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
    assertions: jsonb('assertions')
      .$type<ResponseAssertionConfigurationV1>()
      .notNull()
      .default(EMPTY_ASSERTION_CONFIGURATION),
    locations: jsonb('locations').$type<string[]>().notNull().default(['local']),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),

    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('monitors_id_organization_unique').on(table.id, table.organizationId),

    index('monitors_organization_created_idx').on(table.organizationId, table.createdAt),

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
      sql`jsonb_typeof(${table.locations}) = 'array' and jsonb_array_length(${table.locations}) > 0`,
    ),
    check('monitors_request_headers_array', sql`jsonb_typeof(${table.requestHeaders}) = 'array'`),
    check('monitors_assertions_object', sql`jsonb_typeof(${table.assertions}) = 'object'`),
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
    assertions: jsonb('assertions')
      .$type<ResponseAssertionConfigurationV1>()
      .notNull()
      .default(EMPTY_ASSERTION_CONFIGURATION),

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
      sql`
        jsonb_typeof(${table.locations}) = 'array'
        and jsonb_array_length(${table.locations}) > 0
      `,
    ),
    check(
      'monitor_configuration_versions_request_headers_array',
      sql`jsonb_typeof(${table.requestHeaders}) = 'array'`,
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

    index('check_rounds_monitor_created_idx').on(
      table.organizationId,
      table.monitorId,
      table.createdAt,
      table.id,
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

    status: executionAssignmentStatusEnum('status').notNull().default('PENDING'),

    claimToken: uuid('claim_token'),
    claimExpiresAt: timestamp('claim_expires_at', { withTimezone: true }),
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

    unique('check_execution_assignments_round_location_unique').on(table.roundId, table.location),

    unique('check_execution_assignments_identity_unique').on(
      table.organizationId,
      table.roundId,
      table.id,
    ),

    check('check_execution_assignments_location_local', sql`${table.location} = 'local'`),

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

export type MonitorConfigurationVersionRecord = typeof monitorConfigurationVersions.$inferSelect;

export type NewMonitorConfigurationVersionRecord = typeof monitorConfigurationVersions.$inferInsert;

export type CheckRoundRecord = typeof checkRounds.$inferSelect;

export type CheckExecutionAssignmentRecord = typeof checkExecutionAssignments.$inferSelect;

export type CheckExecutionResultRecord = typeof checkExecutionResults.$inferSelect;

export type CheckRoundOutboxRecord = typeof checkRoundOutbox.$inferSelect;
