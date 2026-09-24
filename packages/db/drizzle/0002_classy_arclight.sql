DROP INDEX "check_round_outbox_unpublished_idx";--> statement-breakpoint
ALTER TABLE "check_round_outbox" ADD COLUMN "available_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "check_round_outbox" ADD COLUMN "claim_token" uuid;--> statement-breakpoint
ALTER TABLE "check_round_outbox" ADD COLUMN "attempt_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "check_round_outbox" ADD COLUMN "last_attempt_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "check_round_outbox" ADD COLUMN "last_error_code" varchar(64);--> statement-breakpoint
ALTER TABLE "check_round_outbox" ADD COLUMN "blocked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "check_round_outbox" ADD COLUMN "blocked_reason" varchar(64);--> statement-breakpoint
CREATE INDEX "check_round_outbox_eligible_idx" ON "check_round_outbox" USING btree ("available_at","created_at","id") WHERE "check_round_outbox"."published_at" is null and "check_round_outbox"."blocked_at" is null;--> statement-breakpoint
ALTER TABLE "check_round_outbox" ADD CONSTRAINT "check_round_outbox_attempt_count_non_negative" CHECK ("check_round_outbox"."attempt_count" >= 0);--> statement-breakpoint
ALTER TABLE "check_round_outbox" ADD CONSTRAINT "check_round_outbox_block_fields_consistent" CHECK (("check_round_outbox"."blocked_at" is null) = ("check_round_outbox"."blocked_reason" is null));--> statement-breakpoint
ALTER TABLE "check_round_outbox" ADD CONSTRAINT "check_round_outbox_not_published_and_blocked" CHECK (not ("check_round_outbox"."published_at" is not null and "check_round_outbox"."blocked_at" is not null));--> statement-breakpoint
ALTER TABLE "check_round_outbox" ADD CONSTRAINT "check_round_outbox_terminal_claim_cleared" CHECK (("check_round_outbox"."published_at" is null and "check_round_outbox"."blocked_at" is null) or "check_round_outbox"."claim_token" is null);--> statement-breakpoint
ALTER TABLE "check_round_outbox" ADD CONSTRAINT "check_round_outbox_published_error_cleared" CHECK ("check_round_outbox"."published_at" is null or "check_round_outbox"."last_error_code" is null);