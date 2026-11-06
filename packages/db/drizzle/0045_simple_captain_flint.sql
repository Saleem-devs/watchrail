ALTER TABLE "webhook_endpoints" ADD COLUMN "notify_on_incident" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "webhook_endpoints" ADD COLUMN "notify_on_recovery" boolean DEFAULT true NOT NULL;--> statement-breakpoint
UPDATE "webhook_endpoints" AS "endpoint"
SET
	"notify_on_incident" = "route_policy"."notify_on_incident",
	"notify_on_recovery" = "route_policy"."notify_on_recovery"
FROM (
	SELECT DISTINCT ON ("organization_id", "endpoint_id")
		"organization_id",
		"endpoint_id",
		"notify_on_incident",
		"notify_on_recovery"
	FROM "webhook_endpoint_monitor_routes"
	ORDER BY "organization_id", "endpoint_id", "monitor_id"
) AS "route_policy"
WHERE
	"endpoint"."organization_id" = "route_policy"."organization_id"
	AND "endpoint"."id" = "route_policy"."endpoint_id";--> statement-breakpoint
ALTER TABLE "webhook_endpoint_monitor_routes" DROP COLUMN "notify_on_incident";--> statement-breakpoint
ALTER TABLE "webhook_endpoint_monitor_routes" DROP COLUMN "notify_on_recovery";
