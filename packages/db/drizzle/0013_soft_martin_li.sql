ALTER TABLE "monitor_configuration_versions" ADD COLUMN "interval_seconds" integer DEFAULT 60 NOT NULL;--> statement-breakpoint
ALTER TABLE "monitors" ADD COLUMN "interval_seconds" integer DEFAULT 60 NOT NULL;--> statement-breakpoint
ALTER TABLE "monitors" ADD COLUMN "next_check_at" timestamp with time zone;--> statement-breakpoint
UPDATE "monitors"
SET "next_check_at" = clock_timestamp() + ("interval_seconds" * interval '1 second')
WHERE "lifecycle_state" = 'ENABLED';--> statement-breakpoint
CREATE INDEX "monitors_due_enabled_idx" ON "monitors" USING btree ("next_check_at","id") WHERE "monitors"."lifecycle_state" = 'ENABLED';--> statement-breakpoint
ALTER TABLE "monitor_configuration_versions" ADD CONSTRAINT "monitor_configuration_versions_interval_range" CHECK ("monitor_configuration_versions"."interval_seconds" between 60 and 86400);--> statement-breakpoint
ALTER TABLE "monitors" ADD CONSTRAINT "monitors_interval_range" CHECK ("monitors"."interval_seconds" between 60 and 86400);--> statement-breakpoint
ALTER TABLE "monitors" ADD CONSTRAINT "monitors_lifecycle_schedule_consistent" CHECK ((
        ("monitors"."lifecycle_state" = 'ENABLED' and "monitors"."next_check_at" is not null)
        or
        ("monitors"."lifecycle_state" in ('PAUSED', 'ARCHIVED') and "monitors"."next_check_at" is null)
      ));
