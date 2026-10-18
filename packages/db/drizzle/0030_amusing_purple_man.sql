CREATE TABLE "auth_email_outbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"recipient_hash" text NOT NULL,
	"supersession_key" text NOT NULL,
	"encrypted_payload" jsonb NOT NULL,
	"expires_at" timestamp NOT NULL,
	"available_at" timestamp DEFAULT now() NOT NULL,
	"claim_token" uuid,
	"lease_expires_at" timestamp,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"published_at" timestamp,
	"delivered_at" timestamp,
	"superseded_at" timestamp,
	"failed_at" timestamp,
	"last_error_code" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "auth_email_outbox_kind_valid" CHECK ("auth_email_outbox"."kind" IN ('OTP', 'INVITATION')),
	CONSTRAINT "auth_email_outbox_attempt_non_negative" CHECK ("auth_email_outbox"."attempt_count" >= 0)
);
--> statement-breakpoint
CREATE INDEX "auth_email_outbox_eligible_idx" ON "auth_email_outbox" USING btree ("available_at","id") WHERE "auth_email_outbox"."published_at" IS NULL AND "auth_email_outbox"."superseded_at" IS NULL AND "auth_email_outbox"."failed_at" IS NULL;--> statement-breakpoint
CREATE INDEX "auth_email_outbox_supersession_idx" ON "auth_email_outbox" USING btree ("supersession_key","created_at");