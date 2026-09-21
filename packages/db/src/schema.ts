import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { HTTP_METHODS, MONITOR_LIFECYCLE_STATES } from '@watchrail/domain';

export const httpMethodEnum = pgEnum('http_method', HTTP_METHODS);
export const monitorLifecycleEnum = pgEnum('monitor_lifecycle_state', MONITOR_LIFECYCLE_STATES);

export const monitors = pgTable(
  'monitors',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id').notNull(),
    name: varchar('name', { length: 120 }).notNull(),
    url: text('url').notNull(),
    method: httpMethodEnum('method').notNull().default('GET'),
    lifecycleState: monitorLifecycleEnum('lifecycle_state').notNull().default('ENABLED'),
    timeoutMs: integer('timeout_ms').notNull().default(10_000),
    locations: jsonb('locations').$type<string[]>().notNull().default(['local']),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
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

export type MonitorRecord = typeof monitors.$inferSelect;
export type NewMonitorRecord = typeof monitors.$inferInsert;
