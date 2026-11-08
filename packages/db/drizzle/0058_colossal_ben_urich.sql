ALTER TYPE "public"."check_result_reason" ADD VALUE 'DOMAIN_HEALTHY' BEFORE 'MISSED_HEARTBEAT';--> statement-breakpoint
ALTER TYPE "public"."check_result_reason" ADD VALUE 'DOMAIN_EXPIRING' BEFORE 'MISSED_HEARTBEAT';--> statement-breakpoint
ALTER TYPE "public"."check_result_reason" ADD VALUE 'DOMAIN_EXPIRED' BEFORE 'MISSED_HEARTBEAT';--> statement-breakpoint
ALTER TYPE "public"."check_result_reason" ADD VALUE 'RDAP_UNAVAILABLE' BEFORE 'MISSED_HEARTBEAT';--> statement-breakpoint
ALTER TYPE "public"."check_result_reason" ADD VALUE 'RDAP_UNSUPPORTED_TLD' BEFORE 'MISSED_HEARTBEAT';--> statement-breakpoint
ALTER TYPE "public"."check_result_reason" ADD VALUE 'DOMAIN_EXPIRATION_UNAVAILABLE' BEFORE 'MISSED_HEARTBEAT';--> statement-breakpoint
ALTER TYPE "public"."check_result_stage" ADD VALUE 'DOMAIN';--> statement-breakpoint
ALTER TYPE "public"."monitor_type" ADD VALUE 'DOMAIN_EXPIRY';
