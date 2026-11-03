ALTER TYPE "public"."check_result_reason" ADD VALUE 'WORKFLOW_COMPLETED';--> statement-breakpoint
ALTER TYPE "public"."check_result_reason" ADD VALUE 'STEP_FAILED';--> statement-breakpoint
ALTER TYPE "public"."check_result_reason" ADD VALUE 'EXTRACTION_FAILED';--> statement-breakpoint
ALTER TYPE "public"."check_result_reason" ADD VALUE 'STEP_INDETERMINATE';--> statement-breakpoint
ALTER TYPE "public"."check_result_reason" ADD VALUE 'EXTRACTION_INDETERMINATE';--> statement-breakpoint
ALTER TYPE "public"."check_result_reason" ADD VALUE 'VARIABLE_UNAVAILABLE';--> statement-breakpoint
ALTER TYPE "public"."check_result_stage" ADD VALUE 'WORKFLOW';--> statement-breakpoint
ALTER TABLE "check_execution_results" ADD COLUMN "workflow_result" jsonb;--> statement-breakpoint
ALTER TABLE "check_execution_results" ADD CONSTRAINT "check_execution_results_workflow_result_object" CHECK ("check_execution_results"."workflow_result" is null or jsonb_typeof("check_execution_results"."workflow_result") = 'object');--> statement-breakpoint
ALTER TABLE "check_execution_results" ADD CONSTRAINT "check_execution_results_workflow_result_consistent" CHECK (("check_execution_results"."stage"::text = 'WORKFLOW') = ("check_execution_results"."workflow_result" is not null));
