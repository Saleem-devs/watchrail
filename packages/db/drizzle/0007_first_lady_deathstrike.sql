ALTER TYPE "public"."check_result_reason" ADD VALUE 'INSECURE_REDIRECT' BEFORE 'INTERNAL_ERROR';--> statement-breakpoint
ALTER TABLE "monitor_configuration_versions" ADD COLUMN "request_headers" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "monitors" ADD COLUMN "request_headers" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "monitor_configuration_versions" ADD CONSTRAINT "monitor_configuration_versions_request_headers_array" CHECK (jsonb_typeof("monitor_configuration_versions"."request_headers") = 'array');--> statement-breakpoint
ALTER TABLE "monitors" ADD CONSTRAINT "monitors_request_headers_array" CHECK (jsonb_typeof("monitors"."request_headers") = 'array');