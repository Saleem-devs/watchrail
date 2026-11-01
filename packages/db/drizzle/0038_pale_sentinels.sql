CREATE TYPE "public"."monitor_type" AS ENUM('HTTP', 'TCP');--> statement-breakpoint
ALTER TYPE "public"."check_result_reason" ADD VALUE 'CONNECTED' BEFORE 'UNEXPECTED_STATUS';--> statement-breakpoint
ALTER TYPE "public"."check_result_reason" ADD VALUE 'CONNECTION_TIMEOUT' BEFORE 'CERTIFICATE_EXPIRED';--> statement-breakpoint
ALTER TYPE "public"."check_result_reason" ADD VALUE 'HOST_UNREACHABLE' BEFORE 'CONNECTION_TIMEOUT';--> statement-breakpoint
ALTER TABLE "monitor_configuration_versions" ADD COLUMN "type" "monitor_type" DEFAULT 'HTTP' NOT NULL;--> statement-breakpoint
ALTER TABLE "monitor_configuration_versions" ADD COLUMN "tcp_host" text;--> statement-breakpoint
ALTER TABLE "monitor_configuration_versions" ADD COLUMN "tcp_port" integer;--> statement-breakpoint
ALTER TABLE "monitors" ADD COLUMN "type" "monitor_type" DEFAULT 'HTTP' NOT NULL;--> statement-breakpoint
ALTER TABLE "monitors" ADD COLUMN "tcp_host" text;--> statement-breakpoint
ALTER TABLE "monitors" ADD COLUMN "tcp_port" integer;--> statement-breakpoint
ALTER TABLE "monitor_configuration_versions" ADD CONSTRAINT "monitor_configuration_versions_protocol_configuration" CHECK ((
        ("monitor_configuration_versions"."type" = 'HTTP' and "monitor_configuration_versions"."tcp_host" is null and "monitor_configuration_versions"."tcp_port" is null)
        or
        ("monitor_configuration_versions"."type" = 'TCP' and length(btrim("monitor_configuration_versions"."tcp_host")) > 0 and "monitor_configuration_versions"."tcp_port" between 1 and 65535)
      ));--> statement-breakpoint
ALTER TABLE "monitors" ADD CONSTRAINT "monitors_protocol_configuration" CHECK ((
        ("monitors"."type" = 'HTTP' and "monitors"."tcp_host" is null and "monitors"."tcp_port" is null)
        or
        ("monitors"."type" = 'TCP' and length(btrim("monitors"."tcp_host")) > 0 and "monitors"."tcp_port" between 1 and 65535)
      ));
