CREATE TYPE "public"."incident_status" AS ENUM('OPEN', 'RESOLVED');--> statement-breakpoint
CREATE TABLE "incidents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"monitor_id" uuid NOT NULL,
	"status" "incident_status" DEFAULT 'OPEN' NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"opened_at" timestamp with time zone NOT NULL,
	"resolved_at" timestamp with time zone,
	"started_by_round_id" uuid NOT NULL,
	"opened_by_round_id" uuid NOT NULL,
	"resolved_by_round_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "incidents_identity_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "incidents_resolution_consistent" CHECK (("incidents"."status" = 'RESOLVED') = ("incidents"."resolved_at" is not null and "incidents"."resolved_by_round_id" is not null))
);
--> statement-breakpoint
CREATE TABLE "monitor_incident_state" (
	"organization_id" uuid NOT NULL,
	"monitor_id" uuid PRIMARY KEY NOT NULL,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"failure_streak_started_at" timestamp with time zone,
	"failure_streak_started_round_id" uuid,
	"last_processed_round_created_at" timestamp with time zone,
	"last_processed_round_id" uuid,
	"tracking_started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "monitor_incident_state_identity_unique" UNIQUE("organization_id","monitor_id"),
	CONSTRAINT "monitor_incident_state_failures_non_negative" CHECK ("monitor_incident_state"."consecutive_failures" >= 0),
	CONSTRAINT "monitor_incident_state_streak_consistent" CHECK (("monitor_incident_state"."consecutive_failures" = 0) = ("monitor_incident_state"."failure_streak_started_at" is null and "monitor_incident_state"."failure_streak_started_round_id" is null)),
	CONSTRAINT "monitor_incident_state_last_processed_consistent" CHECK (("monitor_incident_state"."last_processed_round_created_at" is null) = ("monitor_incident_state"."last_processed_round_id" is null))
);
--> statement-breakpoint
INSERT INTO "monitor_incident_state" (
	"organization_id",
	"monitor_id",
	"tracking_started_at",
	"updated_at"
)
SELECT
	"monitors"."organization_id",
	"monitors"."id",
	"migration_clock"."value",
	"migration_clock"."value"
FROM "monitors"
CROSS JOIN (SELECT clock_timestamp() AS "value") AS "migration_clock";--> statement-breakpoint
ALTER TABLE "incidents" ADD CONSTRAINT "incidents_monitor_fk" FOREIGN KEY ("monitor_id","organization_id") REFERENCES "public"."monitors"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incidents" ADD CONSTRAINT "incidents_started_round_fk" FOREIGN KEY ("organization_id","started_by_round_id") REFERENCES "public"."check_rounds"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incidents" ADD CONSTRAINT "incidents_opened_round_fk" FOREIGN KEY ("organization_id","opened_by_round_id") REFERENCES "public"."check_rounds"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incidents" ADD CONSTRAINT "incidents_resolved_round_fk" FOREIGN KEY ("organization_id","resolved_by_round_id") REFERENCES "public"."check_rounds"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "monitor_incident_state" ADD CONSTRAINT "monitor_incident_state_monitor_fk" FOREIGN KEY ("monitor_id","organization_id") REFERENCES "public"."monitors"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "incidents_monitor_open_unique" ON "incidents" USING btree ("organization_id","monitor_id") WHERE "incidents"."status" = 'OPEN';
