CREATE TYPE "public"."heartbeat_signal_type" AS ENUM('PING', 'START', 'COMPLETE', 'FAIL');--> statement-breakpoint
ALTER TYPE "public"."check_result_reason" ADD VALUE 'SIGNAL_RECEIVED';--> statement-breakpoint
ALTER TYPE "public"."check_result_reason" ADD VALUE 'HEARTBEAT_FAILED';--> statement-breakpoint
ALTER TYPE "public"."check_result_reason" ADD VALUE 'MISSED_HEARTBEAT';--> statement-breakpoint
ALTER TYPE "public"."check_result_reason" ADD VALUE 'RUNTIME_EXCEEDED';--> statement-breakpoint
ALTER TYPE "public"."check_result_stage" ADD VALUE 'HEARTBEAT';--> statement-breakpoint
ALTER TYPE "public"."monitor_type" ADD VALUE 'HEARTBEAT';--> statement-breakpoint
CREATE TABLE "heartbeat_signals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"monitor_id" uuid NOT NULL,
	"signal_type" "heartbeat_signal_type" NOT NULL,
	"run_id" varchar(128),
	"message" varchar(500),
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"runtime_ms" double precision,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "heartbeat_signals_metadata_object" CHECK (jsonb_typeof("heartbeat_signals"."metadata") = 'object'),
	CONSTRAINT "heartbeat_signals_runtime_non_negative" CHECK ("heartbeat_signals"."runtime_ms" is null or "heartbeat_signals"."runtime_ms" >= 0)
);
--> statement-breakpoint
ALTER TABLE "monitor_configuration_versions" DROP CONSTRAINT "monitor_configuration_versions_protocol_configuration";--> statement-breakpoint
ALTER TABLE "monitors" DROP CONSTRAINT "monitors_protocol_configuration";--> statement-breakpoint
ALTER TABLE "check_execution_results" ADD COLUMN "heartbeat_result" jsonb;--> statement-breakpoint
ALTER TABLE "monitor_configuration_versions" ADD COLUMN "heartbeat" jsonb;--> statement-breakpoint
ALTER TABLE "monitors" ADD COLUMN "heartbeat" jsonb;--> statement-breakpoint
ALTER TABLE "monitors" ADD COLUMN "heartbeat_token_hash" varchar(64);--> statement-breakpoint
ALTER TABLE "monitors" ADD COLUMN "heartbeat_last_signal_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "monitors" ADD COLUMN "heartbeat_last_signal_type" varchar(16);--> statement-breakpoint
ALTER TABLE "monitors" ADD COLUMN "heartbeat_last_started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "monitors" ADD COLUMN "heartbeat_last_completed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "monitors" ADD COLUMN "heartbeat_active_run_id" varchar(128);--> statement-breakpoint
ALTER TABLE "heartbeat_signals" ADD CONSTRAINT "heartbeat_signals_monitor_fk" FOREIGN KEY ("monitor_id","organization_id") REFERENCES "public"."monitors"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "heartbeat_signals_monitor_received_idx" ON "heartbeat_signals" USING btree ("organization_id","monitor_id","received_at");--> statement-breakpoint
ALTER TABLE "monitors" ADD CONSTRAINT "monitors_heartbeat_token_hash_unique" UNIQUE("heartbeat_token_hash");--> statement-breakpoint
ALTER TABLE "check_execution_results" ADD CONSTRAINT "check_execution_results_heartbeat_result_object" CHECK ("check_execution_results"."heartbeat_result" is null or jsonb_typeof("check_execution_results"."heartbeat_result") = 'object');--> statement-breakpoint
ALTER TABLE "check_execution_results" ADD CONSTRAINT "check_execution_results_heartbeat_result_consistent" CHECK (("check_execution_results"."stage"::text = 'HEARTBEAT') = ("check_execution_results"."heartbeat_result" is not null));--> statement-breakpoint
ALTER TABLE "monitor_configuration_versions" ADD CONSTRAINT "monitor_configuration_versions_protocol_configuration" CHECK ((
        ("monitor_configuration_versions"."type"::text = 'HTTP' and "monitor_configuration_versions"."tcp_host" is null and "monitor_configuration_versions"."tcp_port" is null and "monitor_configuration_versions"."dns_name" is null and "monitor_configuration_versions"."dns_record_type" is null and "monitor_configuration_versions"."api_workflow" is null and "monitor_configuration_versions"."heartbeat" is null)
        or
        ("monitor_configuration_versions"."type"::text = 'TCP' and length(btrim("monitor_configuration_versions"."tcp_host")) > 0 and "monitor_configuration_versions"."tcp_port" between 1 and 65535 and "monitor_configuration_versions"."dns_name" is null and "monitor_configuration_versions"."dns_record_type" is null and "monitor_configuration_versions"."api_workflow" is null and "monitor_configuration_versions"."heartbeat" is null)
        or
        ("monitor_configuration_versions"."type"::text = 'DNS' and "monitor_configuration_versions"."tcp_host" is null and "monitor_configuration_versions"."tcp_port" is null and length(btrim("monitor_configuration_versions"."dns_name")) > 0 and "monitor_configuration_versions"."dns_record_type" in ('A', 'AAAA', 'CNAME', 'MX', 'TXT', 'NS') and "monitor_configuration_versions"."api_workflow" is null and "monitor_configuration_versions"."heartbeat" is null)
        or
        ("monitor_configuration_versions"."type"::text = 'API_WORKFLOW' and "monitor_configuration_versions"."tcp_host" is null and "monitor_configuration_versions"."tcp_port" is null and "monitor_configuration_versions"."dns_name" is null and "monitor_configuration_versions"."dns_record_type" is null and jsonb_typeof("monitor_configuration_versions"."api_workflow") = 'object' and "monitor_configuration_versions"."heartbeat" is null)
        or
        ("monitor_configuration_versions"."type"::text = 'HEARTBEAT' and "monitor_configuration_versions"."tcp_host" is null and "monitor_configuration_versions"."tcp_port" is null and "monitor_configuration_versions"."dns_name" is null and "monitor_configuration_versions"."dns_record_type" is null and "monitor_configuration_versions"."api_workflow" is null and jsonb_typeof("monitor_configuration_versions"."heartbeat") = 'object')
      ));--> statement-breakpoint
ALTER TABLE "monitors" ADD CONSTRAINT "monitors_protocol_configuration" CHECK ((
        ("monitors"."type"::text = 'HTTP' and "monitors"."tcp_host" is null and "monitors"."tcp_port" is null and "monitors"."dns_name" is null and "monitors"."dns_record_type" is null and "monitors"."api_workflow" is null and "monitors"."heartbeat" is null and "monitors"."heartbeat_token_hash" is null)
        or
        ("monitors"."type"::text = 'TCP' and length(btrim("monitors"."tcp_host")) > 0 and "monitors"."tcp_port" between 1 and 65535 and "monitors"."dns_name" is null and "monitors"."dns_record_type" is null and "monitors"."api_workflow" is null and "monitors"."heartbeat" is null and "monitors"."heartbeat_token_hash" is null)
        or
        ("monitors"."type"::text = 'DNS' and "monitors"."tcp_host" is null and "monitors"."tcp_port" is null and length(btrim("monitors"."dns_name")) > 0 and "monitors"."dns_record_type" in ('A', 'AAAA', 'CNAME', 'MX', 'TXT', 'NS') and "monitors"."api_workflow" is null and "monitors"."heartbeat" is null and "monitors"."heartbeat_token_hash" is null)
        or
        ("monitors"."type"::text = 'API_WORKFLOW' and "monitors"."tcp_host" is null and "monitors"."tcp_port" is null and "monitors"."dns_name" is null and "monitors"."dns_record_type" is null and jsonb_typeof("monitors"."api_workflow") = 'object' and "monitors"."heartbeat" is null and "monitors"."heartbeat_token_hash" is null)
        or
        ("monitors"."type"::text = 'HEARTBEAT' and "monitors"."tcp_host" is null and "monitors"."tcp_port" is null and "monitors"."dns_name" is null and "monitors"."dns_record_type" is null and "monitors"."api_workflow" is null and jsonb_typeof("monitors"."heartbeat") = 'object' and length("monitors"."heartbeat_token_hash") = 64)
      ));