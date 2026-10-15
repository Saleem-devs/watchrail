ALTER TABLE "monitor_configuration_versions" DROP CONSTRAINT "monitor_configuration_versions_locations_non_empty";--> statement-breakpoint
ALTER TABLE "monitors" DROP CONSTRAINT "monitors_locations_non_empty";--> statement-breakpoint
ALTER TABLE "probe_agents" ADD COLUMN "heartbeat_interval_ms" integer DEFAULT 15000 NOT NULL;--> statement-breakpoint
ALTER TABLE "monitor_configuration_versions" ADD CONSTRAINT "monitor_configuration_versions_locations_non_empty" CHECK (
        jsonb_typeof("monitor_configuration_versions"."locations") = 'array'
        and jsonb_array_length("monitor_configuration_versions"."locations") = 1
      );--> statement-breakpoint
ALTER TABLE "monitors" ADD CONSTRAINT "monitors_locations_non_empty" CHECK (jsonb_typeof("monitors"."locations") = 'array' and jsonb_array_length("monitors"."locations") = 1);--> statement-breakpoint
ALTER TABLE "probe_agents" ADD CONSTRAINT "probe_agents_heartbeat_interval_range" CHECK ("probe_agents"."heartbeat_interval_ms" between 5000 and 60000);