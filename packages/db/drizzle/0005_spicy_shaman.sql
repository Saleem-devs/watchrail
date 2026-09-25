ALTER TYPE "public"."check_result_reason" ADD VALUE 'REDIRECT_LOOP' BEFORE 'INTERNAL_ERROR';--> statement-breakpoint
ALTER TYPE "public"."check_result_reason" ADD VALUE 'TOO_MANY_REDIRECTS' BEFORE 'INTERNAL_ERROR';--> statement-breakpoint
ALTER TYPE "public"."check_result_reason" ADD VALUE 'MISSING_REDIRECT_LOCATION' BEFORE 'INTERNAL_ERROR';--> statement-breakpoint
ALTER TYPE "public"."check_result_reason" ADD VALUE 'INVALID_REDIRECT_LOCATION' BEFORE 'INTERNAL_ERROR';