ALTER TYPE "public"."monitor_type" ADD VALUE 'API_WORKFLOW';--> statement-breakpoint
ALTER TABLE "monitor_configuration_versions" DROP CONSTRAINT "monitor_configuration_versions_protocol_configuration";--> statement-breakpoint
ALTER TABLE "monitors" DROP CONSTRAINT "monitors_protocol_configuration";--> statement-breakpoint
ALTER TABLE "monitor_configuration_versions" ADD COLUMN "api_workflow" jsonb;--> statement-breakpoint
ALTER TABLE "monitors" ADD COLUMN "api_workflow" jsonb;--> statement-breakpoint
ALTER TABLE "monitor_configuration_versions" ADD CONSTRAINT "monitor_configuration_versions_protocol_configuration" CHECK ((
        ("monitor_configuration_versions"."type"::text = 'HTTP' and "monitor_configuration_versions"."tcp_host" is null and "monitor_configuration_versions"."tcp_port" is null and "monitor_configuration_versions"."dns_name" is null and "monitor_configuration_versions"."dns_record_type" is null and "monitor_configuration_versions"."api_workflow" is null)
        or
        ("monitor_configuration_versions"."type"::text = 'TCP' and length(btrim("monitor_configuration_versions"."tcp_host")) > 0 and "monitor_configuration_versions"."tcp_port" between 1 and 65535 and "monitor_configuration_versions"."dns_name" is null and "monitor_configuration_versions"."dns_record_type" is null and "monitor_configuration_versions"."api_workflow" is null)
        or
        ("monitor_configuration_versions"."type"::text = 'DNS' and "monitor_configuration_versions"."tcp_host" is null and "monitor_configuration_versions"."tcp_port" is null and length(btrim("monitor_configuration_versions"."dns_name")) > 0 and "monitor_configuration_versions"."dns_record_type" in ('A', 'AAAA', 'CNAME', 'MX', 'TXT', 'NS') and "monitor_configuration_versions"."api_workflow" is null)
        or
        ("monitor_configuration_versions"."type"::text = 'API_WORKFLOW' and "monitor_configuration_versions"."tcp_host" is null and "monitor_configuration_versions"."tcp_port" is null and "monitor_configuration_versions"."dns_name" is null and "monitor_configuration_versions"."dns_record_type" is null and jsonb_typeof("monitor_configuration_versions"."api_workflow") = 'object')
      ));--> statement-breakpoint
ALTER TABLE "monitors" ADD CONSTRAINT "monitors_protocol_configuration" CHECK ((
        ("monitors"."type"::text = 'HTTP' and "monitors"."tcp_host" is null and "monitors"."tcp_port" is null and "monitors"."dns_name" is null and "monitors"."dns_record_type" is null and "monitors"."api_workflow" is null)
        or
        ("monitors"."type"::text = 'TCP' and length(btrim("monitors"."tcp_host")) > 0 and "monitors"."tcp_port" between 1 and 65535 and "monitors"."dns_name" is null and "monitors"."dns_record_type" is null and "monitors"."api_workflow" is null)
        or
        ("monitors"."type"::text = 'DNS' and "monitors"."tcp_host" is null and "monitors"."tcp_port" is null and length(btrim("monitors"."dns_name")) > 0 and "monitors"."dns_record_type" in ('A', 'AAAA', 'CNAME', 'MX', 'TXT', 'NS') and "monitors"."api_workflow" is null)
        or
        ("monitors"."type"::text = 'API_WORKFLOW' and "monitors"."tcp_host" is null and "monitors"."tcp_port" is null and "monitors"."dns_name" is null and "monitors"."dns_record_type" is null and jsonb_typeof("monitors"."api_workflow") = 'object')
      ));