CREATE TYPE "public"."probe_agent_status" AS ENUM('PENDING', 'ACTIVE', 'REVOKED');--> statement-breakpoint
CREATE TYPE "public"."probe_attempt_status" AS ENUM('LEASED', 'SUBMITTED', 'EXPIRED', 'REJECTED');--> statement-breakpoint
CREATE TYPE "public"."probe_credential_status" AS ENUM('ACTIVE', 'REVOKED');--> statement-breakpoint
CREATE TYPE "public"."probe_location_status" AS ENUM('ACTIVE', 'DISABLED');--> statement-breakpoint
CREATE TABLE "probe_agent_credentials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"version_number" integer NOT NULL,
	"verifier" varchar(43) NOT NULL,
	"status" "probe_credential_status" DEFAULT 'ACTIVE' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "probe_agent_credentials_identity_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "probe_agent_credentials_version_unique" UNIQUE("organization_id","agent_id","version_number"),
	CONSTRAINT "probe_agent_credentials_verifier_unique" UNIQUE("verifier"),
	CONSTRAINT "probe_agent_credentials_version_positive" CHECK ("probe_agent_credentials"."version_number" > 0),
	CONSTRAINT "probe_agent_credentials_verifier_format" CHECK ("probe_agent_credentials"."verifier" ~ '^[A-Za-z0-9_-]{43}$'),
	CONSTRAINT "probe_agent_credentials_revocation_consistent" CHECK (("probe_agent_credentials"."status" = 'REVOKED') = ("probe_agent_credentials"."revoked_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "probe_agent_enrollments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"agent_name" varchar(120) NOT NULL,
	"token_verifier" varchar(43) NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"consumed_by_agent_id" uuid,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "probe_agent_enrollments_identity_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "probe_agent_enrollments_verifier_unique" UNIQUE("token_verifier"),
	CONSTRAINT "probe_agent_enrollments_name_not_blank" CHECK (length(btrim("probe_agent_enrollments"."agent_name")) > 0),
	CONSTRAINT "probe_agent_enrollments_verifier_format" CHECK ("probe_agent_enrollments"."token_verifier" ~ '^[A-Za-z0-9_-]{43}$'),
	CONSTRAINT "probe_agent_enrollments_consumption_consistent" CHECK (("probe_agent_enrollments"."consumed_at" is null) = ("probe_agent_enrollments"."consumed_by_agent_id" is null)),
	CONSTRAINT "probe_agent_enrollments_terminal_exclusive" CHECK (not ("probe_agent_enrollments"."consumed_at" is not null and "probe_agent_enrollments"."revoked_at" is not null)),
	CONSTRAINT "probe_agent_enrollments_expiry_after_creation" CHECK ("probe_agent_enrollments"."expires_at" > "probe_agent_enrollments"."created_at")
);
--> statement-breakpoint
CREATE TABLE "probe_agents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"name" varchar(120) NOT NULL,
	"status" "probe_agent_status" DEFAULT 'PENDING' NOT NULL,
	"last_heartbeat_at" timestamp with time zone,
	"engine_version" varchar(64),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "probe_agents_identity_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "probe_agents_location_identity_unique" UNIQUE("organization_id","id","location_id"),
	CONSTRAINT "probe_agents_name_not_blank" CHECK (length(btrim("probe_agents"."name")) > 0),
	CONSTRAINT "probe_agents_revocation_consistent" CHECK (("probe_agents"."status" = 'REVOKED') = ("probe_agents"."revoked_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "probe_execution_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"assignment_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"attempt_number" integer NOT NULL,
	"claim_token_verifier" varchar(43) NOT NULL,
	"status" "probe_attempt_status" DEFAULT 'LEASED' NOT NULL,
	"leased_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_expires_at" timestamp with time zone NOT NULL,
	"submitted_at" timestamp with time zone,
	"terminal_reason" varchar(64),
	"submitted_engine_version" varchar(64),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "probe_execution_attempts_identity_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "probe_execution_attempts_number_unique" UNIQUE("organization_id","assignment_id","attempt_number"),
	CONSTRAINT "probe_execution_attempts_claim_verifier_unique" UNIQUE("claim_token_verifier"),
	CONSTRAINT "probe_execution_attempts_number_positive" CHECK ("probe_execution_attempts"."attempt_number" > 0),
	CONSTRAINT "probe_execution_attempts_claim_verifier_format" CHECK ("probe_execution_attempts"."claim_token_verifier" ~ '^[A-Za-z0-9_-]{43}$'),
	CONSTRAINT "probe_execution_attempts_lease_order" CHECK ("probe_execution_attempts"."lease_expires_at" > "probe_execution_attempts"."leased_at"),
	CONSTRAINT "probe_execution_attempts_submission_consistent" CHECK (("probe_execution_attempts"."status" = 'SUBMITTED') = ("probe_execution_attempts"."submitted_at" is not null and "probe_execution_attempts"."submitted_engine_version" is not null)),
	CONSTRAINT "probe_execution_attempts_terminal_reason_consistent" CHECK (("probe_execution_attempts"."status" in ('EXPIRED', 'REJECTED')) = ("probe_execution_attempts"."terminal_reason" is not null))
);
--> statement-breakpoint
CREATE TABLE "probe_locations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" varchar(120) NOT NULL,
	"slug" varchar(64) NOT NULL,
	"status" "probe_location_status" DEFAULT 'ACTIVE' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "probe_locations_identity_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "probe_locations_slug_unique" UNIQUE("organization_id","slug"),
	CONSTRAINT "probe_locations_name_not_blank" CHECK (length(btrim("probe_locations"."name")) > 0),
	CONSTRAINT "probe_locations_slug_format" CHECK ("probe_locations"."slug" ~ '^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$' and "probe_locations"."slug" <> 'local')
);
--> statement-breakpoint
ALTER TABLE "check_execution_assignments" DROP CONSTRAINT "check_execution_assignments_location_local";--> statement-breakpoint
ALTER TABLE "check_execution_assignments" ADD COLUMN "probe_location_id" uuid;--> statement-breakpoint
ALTER TABLE "check_execution_assignments" ADD COLUMN "execution_policy_version" varchar(64) DEFAULT 'http-v1' NOT NULL;--> statement-breakpoint
ALTER TABLE "check_execution_assignments" ADD COLUMN "required_engine_version" varchar(64) DEFAULT 'watchrail-http-v1' NOT NULL;--> statement-breakpoint
ALTER TABLE "probe_agent_credentials" ADD CONSTRAINT "probe_agent_credentials_agent_fk" FOREIGN KEY ("organization_id","agent_id") REFERENCES "public"."probe_agents"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "probe_agent_enrollments" ADD CONSTRAINT "probe_agent_enrollments_location_fk" FOREIGN KEY ("organization_id","location_id") REFERENCES "public"."probe_locations"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "probe_agent_enrollments" ADD CONSTRAINT "probe_agent_enrollments_agent_fk" FOREIGN KEY ("organization_id","consumed_by_agent_id","location_id") REFERENCES "public"."probe_agents"("organization_id","id","location_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "probe_agents" ADD CONSTRAINT "probe_agents_location_fk" FOREIGN KEY ("organization_id","location_id") REFERENCES "public"."probe_locations"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "check_execution_assignments" ADD CONSTRAINT "check_execution_assignments_organization_id_unique" UNIQUE("organization_id","id");--> statement-breakpoint
ALTER TABLE "check_execution_assignments" ADD CONSTRAINT "check_execution_assignments_location_identity_unique" UNIQUE("organization_id","id","probe_location_id");--> statement-breakpoint
ALTER TABLE "probe_execution_attempts" ADD CONSTRAINT "probe_execution_attempts_assignment_fk" FOREIGN KEY ("organization_id","assignment_id","location_id") REFERENCES "public"."check_execution_assignments"("organization_id","id","probe_location_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "probe_execution_attempts" ADD CONSTRAINT "probe_execution_attempts_agent_fk" FOREIGN KEY ("organization_id","agent_id","location_id") REFERENCES "public"."probe_agents"("organization_id","id","location_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "probe_agent_credentials_one_active_unique" ON "probe_agent_credentials" USING btree ("organization_id","agent_id") WHERE "probe_agent_credentials"."status" = 'ACTIVE';--> statement-breakpoint
CREATE INDEX "probe_agent_enrollments_location_idx" ON "probe_agent_enrollments" USING btree ("organization_id","location_id","created_at");--> statement-breakpoint
CREATE INDEX "probe_agents_location_idx" ON "probe_agents" USING btree ("organization_id","location_id","created_at","id");--> statement-breakpoint
CREATE INDEX "probe_execution_attempts_assignment_idx" ON "probe_execution_attempts" USING btree ("organization_id","assignment_id","attempt_number");--> statement-breakpoint
CREATE INDEX "probe_execution_attempts_lease_idx" ON "probe_execution_attempts" USING btree ("status","lease_expires_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "probe_execution_attempts_one_leased_unique" ON "probe_execution_attempts" USING btree ("organization_id","assignment_id") WHERE "probe_execution_attempts"."status" = 'LEASED';--> statement-breakpoint
CREATE INDEX "probe_locations_organization_idx" ON "probe_locations" USING btree ("organization_id","created_at","id");--> statement-breakpoint
ALTER TABLE "check_execution_assignments" ADD CONSTRAINT "check_execution_assignments_probe_location_fk" FOREIGN KEY ("organization_id","probe_location_id") REFERENCES "public"."probe_locations"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "check_execution_assignments" ADD CONSTRAINT "check_execution_assignments_location_consistent" CHECK ((
        ("check_execution_assignments"."location" = 'local' and "check_execution_assignments"."probe_location_id" is null)
        or
        ("check_execution_assignments"."probe_location_id" is not null and "check_execution_assignments"."location" = "check_execution_assignments"."probe_location_id"::text)
      ));--> statement-breakpoint
ALTER TABLE "check_execution_assignments" ADD CONSTRAINT "check_execution_assignments_policy_version_format" CHECK ("check_execution_assignments"."execution_policy_version" ~ '^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$');--> statement-breakpoint
ALTER TABLE "check_execution_assignments" ADD CONSTRAINT "check_execution_assignments_engine_version_format" CHECK ("check_execution_assignments"."required_engine_version" ~ '^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$');
