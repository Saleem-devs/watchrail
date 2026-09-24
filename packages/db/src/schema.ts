import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import type { ExecuteCheckRoundJobV1 } from '@watchrail/contracts';
import {
  CHECK_ROUND_STATUSES,
  CHECK_ROUND_TRIGGERS,
  EXECUTION_ASSIGNMENT_STATUSES,
  HTTP_METHODS,
  MONITOR_LIFECYCLE_STATES,
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
  'INTERNAL_ERROR',
]);

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

    check(
      'monitors_locations_non_empty',
      sql`jsonb_typeof(${table.locations}) = 'array' and jsonb_array_length(${table.locations}) > 0`,
    ),
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
      'monitor_configuration_versions_locations_non_empty',
      sql`
        jsonb_typeof(${table.locations}) = 'array'
        and jsonb_array_length(${table.locations}) > 0
      `,
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
