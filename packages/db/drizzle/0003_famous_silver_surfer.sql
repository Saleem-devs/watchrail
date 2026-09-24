CREATE TYPE "public"."check_result_outcome" AS ENUM('PASS', 'FAIL', 'UNKNOWN');--> statement-breakpoint
CREATE TYPE "public"."check_result_reason" AS ENUM('COMPLETED', 'UNEXPECTED_STATUS', 'REQUEST_TIMEOUT', 'NAME_NOT_FOUND', 'CONNECTION_REFUSED', 'CERTIFICATE_EXPIRED', 'INTERNAL_ERROR');--> statement-breakpoint
CREATE TYPE "public"."check_result_stage" AS ENUM('DNS', 'CONNECT', 'TLS', 'HTTP', 'PROBE');--> statement-breakpoint
ALTER TYPE "public"."check_round_status" RENAME TO "check_round_status_old";--> statement-breakpoint
CREATE TYPE "public"."check_round_status" AS ENUM('PENDING', 'COMPLETED');--> statement-breakpoint
ALTER TABLE "check_rounds" ALTER COLUMN "status" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "check_rounds" ALTER COLUMN "status" TYPE "public"."check_round_status" USING "status"::text::"public"."check_round_status";--> statement-breakpoint
ALTER TABLE "check_rounds" ALTER COLUMN "status" SET DEFAULT 'PENDING';--> statement-breakpoint
DROP TYPE "public"."check_round_status_old";--> statement-breakpoint
ALTER TYPE "public"."execution_assignment_status" RENAME TO "execution_assignment_status_old";--> statement-breakpoint
CREATE TYPE "public"."execution_assignment_status" AS ENUM('PENDING', 'RUNNING', 'COMPLETED');--> statement-breakpoint
ALTER TABLE "check_execution_assignments" ALTER COLUMN "status" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "check_execution_assignments" ALTER COLUMN "status" TYPE "public"."execution_assignment_status" USING "status"::text::"public"."execution_assignment_status";--> statement-breakpoint
ALTER TABLE "check_execution_assignments" ALTER COLUMN "status" SET DEFAULT 'PENDING';--> statement-breakpoint
DROP TYPE "public"."execution_assignment_status_old";--> statement-breakpoint
CREATE TABLE "check_execution_results" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"round_id" uuid NOT NULL,
	"assignment_id" uuid NOT NULL,
	"outcome" "check_result_outcome" NOT NULL,
	"stage" "check_result_stage" NOT NULL,
	"reason" "check_result_reason" NOT NULL,
	"status_code" integer,
	"response_time_ms" double precision,
	"attempt_duration_ms" double precision NOT NULL,
	"checked_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "check_execution_results_assignment_unique" UNIQUE("assignment_id"),
	CONSTRAINT "check_execution_results_status_code_range" CHECK ("check_execution_results"."status_code" is null or "check_execution_results"."status_code" between 100 and 599),
	CONSTRAINT "check_execution_results_response_evidence_consistent" CHECK (("check_execution_results"."status_code" is null) = ("check_execution_results"."response_time_ms" is null)),
	CONSTRAINT "check_execution_results_response_time_non_negative" CHECK ("check_execution_results"."response_time_ms" is null or "check_execution_results"."response_time_ms" >= 0),
	CONSTRAINT "check_execution_results_attempt_duration_non_negative" CHECK ("check_execution_results"."attempt_duration_ms" >= 0)
);
--> statement-breakpoint
ALTER TABLE "check_execution_assignments" ADD COLUMN "claim_token" uuid;--> statement-breakpoint
ALTER TABLE "check_execution_assignments" ADD COLUMN "claim_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "check_execution_assignments" ADD COLUMN "attempt_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "check_execution_assignments" ADD COLUMN "last_started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "check_execution_assignments" ADD COLUMN "completed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "check_execution_assignments" ADD CONSTRAINT "check_execution_assignments_identity_unique" UNIQUE("organization_id","round_id","id");--> statement-breakpoint
ALTER TABLE "check_execution_results" ADD CONSTRAINT "check_execution_results_assignment_fk" FOREIGN KEY ("organization_id","round_id","assignment_id") REFERENCES "public"."check_execution_assignments"("organization_id","round_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "check_execution_results_round_idx" ON "check_execution_results" USING btree ("organization_id","round_id","checked_at");--> statement-breakpoint
ALTER TABLE "check_execution_assignments" ADD CONSTRAINT "check_execution_assignments_attempt_count_non_negative" CHECK ("check_execution_assignments"."attempt_count" >= 0);--> statement-breakpoint
ALTER TABLE "check_execution_assignments" ADD CONSTRAINT "check_execution_assignments_claim_consistent" CHECK (
        ("check_execution_assignments"."status" = 'RUNNING') =
        ("check_execution_assignments"."claim_token" is not null and "check_execution_assignments"."claim_expires_at" is not null)
      );--> statement-breakpoint
ALTER TABLE "check_execution_assignments" ADD CONSTRAINT "check_execution_assignments_completion_consistent" CHECK (("check_execution_assignments"."status" = 'COMPLETED') = ("check_execution_assignments"."completed_at" is not null));
