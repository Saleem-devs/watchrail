ALTER TABLE "incidents" DROP CONSTRAINT "incidents_severity_valid";--> statement-breakpoint
ALTER TABLE "incidents" ADD COLUMN "group_key" varchar(64);--> statement-breakpoint
UPDATE "incidents"
SET
	"severity" = coalesce("severity", 'DOWN'),
	"group_key" = 'availability:' || lower("monitor_id"::text);--> statement-breakpoint
ALTER TABLE "incidents" ALTER COLUMN "severity" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "incidents" ALTER COLUMN "group_key" SET NOT NULL;--> statement-breakpoint
CREATE INDEX "incidents_group_opened_idx" ON "incidents" USING btree ("organization_id","group_key","opened_at","id");--> statement-breakpoint
ALTER TABLE "incidents" ADD CONSTRAINT "incidents_severity_valid" CHECK ("incidents"."severity" in ('DEGRADED', 'DOWN'));
