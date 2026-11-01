ALTER TYPE "public"."check_result_reason" ADD VALUE 'CERTIFICATE_EXPIRING' BEFORE 'TLS_HANDSHAKE_FAILED';--> statement-breakpoint
ALTER TABLE "check_execution_results" ADD COLUMN "tls_certificates" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "monitor_configuration_versions" ADD COLUMN "tls_policy" jsonb DEFAULT '{"type":"DISABLED"}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "monitors" ADD COLUMN "tls_policy" jsonb DEFAULT '{"type":"DISABLED"}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "check_execution_results" ADD CONSTRAINT "check_execution_results_tls_certificates_array" CHECK (jsonb_typeof("check_execution_results"."tls_certificates") = 'array');