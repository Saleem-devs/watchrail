ALTER TABLE "check_execution_assignments" ADD COLUMN "pending_since" timestamp with time zone;
--> statement-breakpoint
UPDATE "check_execution_assignments"
SET "pending_since" = "created_at";
--> statement-breakpoint
ALTER TABLE "check_execution_assignments" ALTER COLUMN "pending_since" SET DEFAULT now();
--> statement-breakpoint
ALTER TABLE "check_execution_assignments" ALTER COLUMN "pending_since" SET NOT NULL;
