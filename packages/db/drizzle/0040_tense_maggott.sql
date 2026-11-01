ALTER TYPE "public"."check_result_reason" ADD VALUE 'RECORDS_MATCHED' BEFORE 'CERTIFICATE_EXPIRED';--> statement-breakpoint
ALTER TYPE "public"."check_result_reason" ADD VALUE 'NO_RECORDS' BEFORE 'CERTIFICATE_EXPIRED';--> statement-breakpoint
ALTER TYPE "public"."check_result_reason" ADD VALUE 'RECORD_MISMATCH' BEFORE 'CERTIFICATE_EXPIRED';--> statement-breakpoint
ALTER TYPE "public"."check_result_reason" ADD VALUE 'DNS_TIMEOUT' BEFORE 'CERTIFICATE_EXPIRED';--> statement-breakpoint
ALTER TYPE "public"."monitor_type" ADD VALUE 'DNS';--> statement-breakpoint
ALTER TABLE "check_execution_results" DROP CONSTRAINT "check_execution_results_response_evidence_consistent";--> statement-breakpoint
ALTER TABLE "monitor_configuration_versions" DROP CONSTRAINT "monitor_configuration_versions_protocol_configuration";--> statement-breakpoint
ALTER TABLE "monitors" DROP CONSTRAINT "monitors_protocol_configuration";--> statement-breakpoint
ALTER TABLE "check_execution_results" ADD COLUMN "dns_answers" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "monitor_configuration_versions" ADD COLUMN "dns_name" text;--> statement-breakpoint
ALTER TABLE "monitor_configuration_versions" ADD COLUMN "dns_record_type" varchar(8);--> statement-breakpoint
ALTER TABLE "monitor_configuration_versions" ADD COLUMN "dns_expected_values" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "monitors" ADD COLUMN "dns_name" text;--> statement-breakpoint
ALTER TABLE "monitors" ADD COLUMN "dns_record_type" varchar(8);--> statement-breakpoint
ALTER TABLE "monitors" ADD COLUMN "dns_expected_values" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "check_execution_results" ADD CONSTRAINT "check_execution_results_dns_answers_array" CHECK (jsonb_typeof("check_execution_results"."dns_answers") = 'array' and jsonb_array_length("check_execution_results"."dns_answers") <= 32);--> statement-breakpoint
ALTER TABLE "check_execution_results" ADD CONSTRAINT "check_execution_results_response_evidence_consistent" CHECK ((
        (("check_execution_results"."status_code" is null) = ("check_execution_results"."response_time_ms" is null))
        or
        ("check_execution_results"."status_code" is null and "check_execution_results"."response_time_ms" is not null and (
          ("check_execution_results"."stage" = 'CONNECT' and "check_execution_results"."reason" = 'CONNECTED')
          or
          ("check_execution_results"."stage" = 'DNS' and "check_execution_results"."reason"::text in ('RECORDS_MATCHED', 'NO_RECORDS', 'RECORD_MISMATCH'))
        ))
      ));--> statement-breakpoint
ALTER TABLE "monitor_configuration_versions" ADD CONSTRAINT "monitor_configuration_versions_dns_expected_values_array" CHECK (jsonb_typeof("monitor_configuration_versions"."dns_expected_values") = 'array' and jsonb_array_length("monitor_configuration_versions"."dns_expected_values") <= 32);--> statement-breakpoint
ALTER TABLE "monitor_configuration_versions" ADD CONSTRAINT "monitor_configuration_versions_protocol_configuration" CHECK ((
        ("monitor_configuration_versions"."type"::text = 'HTTP' and "monitor_configuration_versions"."tcp_host" is null and "monitor_configuration_versions"."tcp_port" is null and "monitor_configuration_versions"."dns_name" is null and "monitor_configuration_versions"."dns_record_type" is null)
        or
        ("monitor_configuration_versions"."type"::text = 'TCP' and length(btrim("monitor_configuration_versions"."tcp_host")) > 0 and "monitor_configuration_versions"."tcp_port" between 1 and 65535 and "monitor_configuration_versions"."dns_name" is null and "monitor_configuration_versions"."dns_record_type" is null)
        or
        ("monitor_configuration_versions"."type"::text = 'DNS' and "monitor_configuration_versions"."tcp_host" is null and "monitor_configuration_versions"."tcp_port" is null and length(btrim("monitor_configuration_versions"."dns_name")) > 0 and "monitor_configuration_versions"."dns_record_type" in ('A', 'AAAA', 'CNAME', 'MX', 'TXT', 'NS'))
      ));--> statement-breakpoint
ALTER TABLE "monitors" ADD CONSTRAINT "monitors_dns_expected_values_array" CHECK (jsonb_typeof("monitors"."dns_expected_values") = 'array' and jsonb_array_length("monitors"."dns_expected_values") <= 32);--> statement-breakpoint
ALTER TABLE "monitors" ADD CONSTRAINT "monitors_protocol_configuration" CHECK ((
        ("monitors"."type"::text = 'HTTP' and "monitors"."tcp_host" is null and "monitors"."tcp_port" is null and "monitors"."dns_name" is null and "monitors"."dns_record_type" is null)
        or
        ("monitors"."type"::text = 'TCP' and length(btrim("monitors"."tcp_host")) > 0 and "monitors"."tcp_port" between 1 and 65535 and "monitors"."dns_name" is null and "monitors"."dns_record_type" is null)
        or
        ("monitors"."type"::text = 'DNS' and "monitors"."tcp_host" is null and "monitors"."tcp_port" is null and length(btrim("monitors"."dns_name")) > 0 and "monitors"."dns_record_type" in ('A', 'AAAA', 'CNAME', 'MX', 'TXT', 'NS'))
      ));
