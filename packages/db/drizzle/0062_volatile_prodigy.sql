ALTER TYPE "public"."check_result_reason" ADD VALUE 'PING_REPLIED';--> statement-breakpoint
ALTER TYPE "public"."check_result_reason" ADD VALUE 'PING_TIMEOUT';--> statement-breakpoint
ALTER TYPE "public"."check_result_reason" ADD VALUE 'PING_HOST_UNREACHABLE';--> statement-breakpoint
ALTER TYPE "public"."check_result_reason" ADD VALUE 'ICMP_UNAVAILABLE';--> statement-breakpoint
ALTER TYPE "public"."check_result_stage" ADD VALUE 'ICMP';--> statement-breakpoint
ALTER TYPE "public"."monitor_type" ADD VALUE 'ICMP';--> statement-breakpoint
ALTER TABLE "check_execution_results" DROP CONSTRAINT "check_execution_results_response_evidence_consistent";--> statement-breakpoint
ALTER TABLE "monitor_configuration_versions" DROP CONSTRAINT "monitor_configuration_versions_protocol_configuration";--> statement-breakpoint
ALTER TABLE "monitors" DROP CONSTRAINT "monitors_protocol_configuration";--> statement-breakpoint
ALTER TABLE "monitor_configuration_versions" ADD COLUMN "icmp_host" text;--> statement-breakpoint
ALTER TABLE "monitors" ADD COLUMN "icmp_host" text;--> statement-breakpoint
ALTER TABLE "check_execution_results" ADD CONSTRAINT "check_execution_results_response_evidence_consistent" CHECK ((
        (("check_execution_results"."status_code" is null) = ("check_execution_results"."response_time_ms" is null))
        or
        ("check_execution_results"."status_code" is null and "check_execution_results"."response_time_ms" is not null and (
          ("check_execution_results"."stage" = 'CONNECT' and "check_execution_results"."reason" = 'CONNECTED')
          or
          ("check_execution_results"."stage"::text = 'ICMP' and "check_execution_results"."reason"::text = 'PING_REPLIED')
          or
          ("check_execution_results"."stage" = 'DNS' and "check_execution_results"."reason"::text in ('RECORDS_MATCHED', 'NO_RECORDS', 'RECORD_MISMATCH'))
          or
          ("check_execution_results"."stage"::text = 'DOMAIN' and "check_execution_results"."reason"::text in ('DOMAIN_HEALTHY', 'DOMAIN_EXPIRING', 'DOMAIN_EXPIRED', 'DOMAIN_EXPIRATION_UNAVAILABLE'))
        ))
      ));--> statement-breakpoint
ALTER TABLE "monitor_configuration_versions" ADD CONSTRAINT "monitor_configuration_versions_protocol_configuration" CHECK ((
        ("monitor_configuration_versions"."type"::text = 'HTTP' and "monitor_configuration_versions"."tcp_host" is null and "monitor_configuration_versions"."tcp_port" is null and "monitor_configuration_versions"."icmp_host" is null and "monitor_configuration_versions"."dns_name" is null and "monitor_configuration_versions"."dns_record_type" is null and "monitor_configuration_versions"."domain_name" is null and "monitor_configuration_versions"."domain_warning_days" is null and "monitor_configuration_versions"."api_workflow" is null and "monitor_configuration_versions"."heartbeat" is null)
        or
        ("monitor_configuration_versions"."type"::text = 'TCP' and length(btrim("monitor_configuration_versions"."tcp_host")) > 0 and "monitor_configuration_versions"."tcp_port" between 1 and 65535 and "monitor_configuration_versions"."icmp_host" is null and "monitor_configuration_versions"."dns_name" is null and "monitor_configuration_versions"."dns_record_type" is null and "monitor_configuration_versions"."domain_name" is null and "monitor_configuration_versions"."domain_warning_days" is null and "monitor_configuration_versions"."api_workflow" is null and "monitor_configuration_versions"."heartbeat" is null)
        or
        ("monitor_configuration_versions"."type"::text = 'ICMP' and "monitor_configuration_versions"."tcp_host" is null and "monitor_configuration_versions"."tcp_port" is null and length(btrim("monitor_configuration_versions"."icmp_host")) > 0 and "monitor_configuration_versions"."dns_name" is null and "monitor_configuration_versions"."dns_record_type" is null and "monitor_configuration_versions"."domain_name" is null and "monitor_configuration_versions"."domain_warning_days" is null and "monitor_configuration_versions"."api_workflow" is null and "monitor_configuration_versions"."heartbeat" is null)
        or
        ("monitor_configuration_versions"."type"::text = 'DNS' and "monitor_configuration_versions"."tcp_host" is null and "monitor_configuration_versions"."tcp_port" is null and "monitor_configuration_versions"."icmp_host" is null and length(btrim("monitor_configuration_versions"."dns_name")) > 0 and "monitor_configuration_versions"."dns_record_type" in ('A', 'AAAA', 'CNAME', 'MX', 'TXT', 'NS') and "monitor_configuration_versions"."domain_name" is null and "monitor_configuration_versions"."domain_warning_days" is null and "monitor_configuration_versions"."api_workflow" is null and "monitor_configuration_versions"."heartbeat" is null)
        or
        ("monitor_configuration_versions"."type"::text = 'API_WORKFLOW' and "monitor_configuration_versions"."tcp_host" is null and "monitor_configuration_versions"."tcp_port" is null and "monitor_configuration_versions"."icmp_host" is null and "monitor_configuration_versions"."dns_name" is null and "monitor_configuration_versions"."dns_record_type" is null and "monitor_configuration_versions"."domain_name" is null and "monitor_configuration_versions"."domain_warning_days" is null and jsonb_typeof("monitor_configuration_versions"."api_workflow") = 'object' and "monitor_configuration_versions"."heartbeat" is null)
        or
        ("monitor_configuration_versions"."type"::text = 'HEARTBEAT' and "monitor_configuration_versions"."tcp_host" is null and "monitor_configuration_versions"."tcp_port" is null and "monitor_configuration_versions"."icmp_host" is null and "monitor_configuration_versions"."dns_name" is null and "monitor_configuration_versions"."dns_record_type" is null and "monitor_configuration_versions"."domain_name" is null and "monitor_configuration_versions"."domain_warning_days" is null and "monitor_configuration_versions"."api_workflow" is null and jsonb_typeof("monitor_configuration_versions"."heartbeat") = 'object')
        or
        ("monitor_configuration_versions"."type"::text = 'DOMAIN_EXPIRY' and "monitor_configuration_versions"."tcp_host" is null and "monitor_configuration_versions"."tcp_port" is null and "monitor_configuration_versions"."icmp_host" is null and "monitor_configuration_versions"."dns_name" is null and "monitor_configuration_versions"."dns_record_type" is null and "monitor_configuration_versions"."domain_name" is not null and length(btrim("monitor_configuration_versions"."domain_name")) > 0 and "monitor_configuration_versions"."domain_warning_days" is not null and "monitor_configuration_versions"."domain_warning_days" between 1 and 365 and "monitor_configuration_versions"."api_workflow" is null and "monitor_configuration_versions"."heartbeat" is null)
      ));--> statement-breakpoint
ALTER TABLE "monitors" ADD CONSTRAINT "monitors_protocol_configuration" CHECK ((
        ("monitors"."type"::text = 'HTTP' and "monitors"."tcp_host" is null and "monitors"."tcp_port" is null and "monitors"."icmp_host" is null and "monitors"."dns_name" is null and "monitors"."dns_record_type" is null and "monitors"."domain_name" is null and "monitors"."domain_warning_days" is null and "monitors"."api_workflow" is null and "monitors"."heartbeat" is null and "monitors"."heartbeat_token_hash" is null)
        or
        ("monitors"."type"::text = 'TCP' and length(btrim("monitors"."tcp_host")) > 0 and "monitors"."tcp_port" between 1 and 65535 and "monitors"."icmp_host" is null and "monitors"."dns_name" is null and "monitors"."dns_record_type" is null and "monitors"."domain_name" is null and "monitors"."domain_warning_days" is null and "monitors"."api_workflow" is null and "monitors"."heartbeat" is null and "monitors"."heartbeat_token_hash" is null)
        or
        ("monitors"."type"::text = 'ICMP' and "monitors"."tcp_host" is null and "monitors"."tcp_port" is null and length(btrim("monitors"."icmp_host")) > 0 and "monitors"."dns_name" is null and "monitors"."dns_record_type" is null and "monitors"."domain_name" is null and "monitors"."domain_warning_days" is null and "monitors"."api_workflow" is null and "monitors"."heartbeat" is null and "monitors"."heartbeat_token_hash" is null)
        or
        ("monitors"."type"::text = 'DNS' and "monitors"."tcp_host" is null and "monitors"."tcp_port" is null and "monitors"."icmp_host" is null and length(btrim("monitors"."dns_name")) > 0 and "monitors"."dns_record_type" in ('A', 'AAAA', 'CNAME', 'MX', 'TXT', 'NS') and "monitors"."domain_name" is null and "monitors"."domain_warning_days" is null and "monitors"."api_workflow" is null and "monitors"."heartbeat" is null and "monitors"."heartbeat_token_hash" is null)
        or
        ("monitors"."type"::text = 'API_WORKFLOW' and "monitors"."tcp_host" is null and "monitors"."tcp_port" is null and "monitors"."icmp_host" is null and "monitors"."dns_name" is null and "monitors"."dns_record_type" is null and "monitors"."domain_name" is null and "monitors"."domain_warning_days" is null and jsonb_typeof("monitors"."api_workflow") = 'object' and "monitors"."heartbeat" is null and "monitors"."heartbeat_token_hash" is null)
        or
        ("monitors"."type"::text = 'HEARTBEAT' and "monitors"."tcp_host" is null and "monitors"."tcp_port" is null and "monitors"."icmp_host" is null and "monitors"."dns_name" is null and "monitors"."dns_record_type" is null and "monitors"."domain_name" is null and "monitors"."domain_warning_days" is null and "monitors"."api_workflow" is null and jsonb_typeof("monitors"."heartbeat") = 'object' and length("monitors"."heartbeat_token_hash") = 64)
        or
        ("monitors"."type"::text = 'DOMAIN_EXPIRY' and "monitors"."tcp_host" is null and "monitors"."tcp_port" is null and "monitors"."icmp_host" is null and "monitors"."dns_name" is null and "monitors"."dns_record_type" is null and "monitors"."domain_name" is not null and length(btrim("monitors"."domain_name")) > 0 and "monitors"."domain_warning_days" is not null and "monitors"."domain_warning_days" between 1 and 365 and "monitors"."api_workflow" is null and "monitors"."heartbeat" is null and "monitors"."heartbeat_token_hash" is null)
      ));