CREATE TYPE "public"."availability_window_state" AS ENUM('AVAILABLE', 'UNAVAILABLE', 'UNKNOWN', 'EXCLUDED');--> statement-breakpoint
CREATE TABLE "monitor_availability_daily" (
	"organization_id" uuid NOT NULL,
	"monitor_id" uuid NOT NULL,
	"day_utc" date NOT NULL,
	"available_ms" integer DEFAULT 0 NOT NULL,
	"unavailable_ms" integer DEFAULT 0 NOT NULL,
	"unknown_ms" integer DEFAULT 0 NOT NULL,
	"excluded_ms" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "monitor_availability_daily_organization_id_monitor_id_day_utc_pk" PRIMARY KEY("organization_id","monitor_id","day_utc"),
	CONSTRAINT "monitor_availability_daily_duration_bounds" CHECK ("monitor_availability_daily"."available_ms" >= 0 and "monitor_availability_daily"."unavailable_ms" >= 0 and "monitor_availability_daily"."unknown_ms" >= 0 and "monitor_availability_daily"."excluded_ms" >= 0 and "monitor_availability_daily"."available_ms"::bigint + "monitor_availability_daily"."unavailable_ms" + "monitor_availability_daily"."unknown_ms" + "monitor_availability_daily"."excluded_ms" <= 86400000)
);
--> statement-breakpoint
CREATE TABLE "monitor_availability_state" (
	"organization_id" uuid NOT NULL,
	"monitor_id" uuid PRIMARY KEY NOT NULL,
	"current_state" "availability_window_state" NOT NULL,
	"state_since" timestamp with time zone NOT NULL,
	"accounted_through" timestamp with time zone NOT NULL,
	"tracking_started_at" timestamp with time zone NOT NULL,
	"enabled_since" timestamp with time zone,
	"last_processed_round_created_at" timestamp with time zone,
	"last_processed_round_id" uuid,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "monitor_availability_state_time_order" CHECK ("monitor_availability_state"."tracking_started_at" <= "monitor_availability_state"."state_since" and "monitor_availability_state"."state_since" <= "monitor_availability_state"."accounted_through"),
	CONSTRAINT "monitor_availability_state_epoch_consistent" CHECK (("monitor_availability_state"."current_state" = 'EXCLUDED') = ("monitor_availability_state"."enabled_since" is null)),
	CONSTRAINT "monitor_availability_state_watermark_consistent" CHECK (("monitor_availability_state"."last_processed_round_created_at" is null) = ("monitor_availability_state"."last_processed_round_id" is null))
);
--> statement-breakpoint
ALTER TABLE "monitor_availability_daily" ADD CONSTRAINT "monitor_availability_daily_monitor_fk" FOREIGN KEY ("monitor_id","organization_id") REFERENCES "public"."monitors"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "monitor_availability_state" ADD CONSTRAINT "monitor_availability_state_monitor_fk" FOREIGN KEY ("monitor_id","organization_id") REFERENCES "public"."monitors"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "monitor_availability_state_flush_idx" ON "monitor_availability_state" USING btree ("accounted_through","monitor_id");--> statement-breakpoint
-- Tracking starts here, not at monitor creation or any historical check time.
WITH migration_clock AS MATERIALIZED (
  SELECT date_trunc('milliseconds', clock_timestamp()) AS at
)
INSERT INTO monitor_availability_state (
  organization_id, monitor_id, current_state, state_since, accounted_through,
  tracking_started_at, enabled_since, updated_at
)
SELECT organization_id, id,
  CASE WHEN lifecycle_state = 'ENABLED' THEN 'UNKNOWN' ELSE 'EXCLUDED' END::availability_window_state,
  at, at, at, CASE WHEN lifecycle_state = 'ENABLED' THEN at ELSE NULL END, at
FROM monitors CROSS JOIN migration_clock;
