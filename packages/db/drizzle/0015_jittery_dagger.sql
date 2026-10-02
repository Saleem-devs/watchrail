DROP INDEX "check_rounds_monitor_created_idx";--> statement-breakpoint
CREATE INDEX "check_rounds_monitor_created_idx" ON "check_rounds" USING btree ("organization_id","monitor_id","created_at","id");