CREATE TYPE "public"."workspace_secret_audit_action" AS ENUM('CREATED', 'DESCRIPTION_UPDATED', 'ROTATED', 'ARCHIVED');--> statement-breakpoint
CREATE TABLE "workspace_secret_audit_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"secret_id" uuid NOT NULL,
	"actor_id" uuid NOT NULL,
	"action" "workspace_secret_audit_action" NOT NULL,
	"version_number" integer,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_secret_audit_events_version_positive" CHECK ("workspace_secret_audit_events"."version_number" is null or "workspace_secret_audit_events"."version_number" > 0)
);
--> statement-breakpoint
CREATE TABLE "workspace_secret_bindings" (
	"organization_id" uuid NOT NULL,
	"secret_id" uuid NOT NULL,
	"resource_type" varchar(32) NOT NULL,
	"resource_id" uuid NOT NULL,
	"resource_path" varchar(240) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_secret_bindings_pk" PRIMARY KEY("organization_id","secret_id","resource_type","resource_id","resource_path"),
	CONSTRAINT "workspace_secret_bindings_resource_type_not_blank" CHECK (length(btrim("workspace_secret_bindings"."resource_type")) > 0),
	CONSTRAINT "workspace_secret_bindings_resource_path_not_blank" CHECK (length(btrim("workspace_secret_bindings"."resource_path")) > 0)
);
--> statement-breakpoint
CREATE TABLE "workspace_secret_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"secret_id" uuid NOT NULL,
	"version_number" integer NOT NULL,
	"encrypted_value" jsonb NOT NULL,
	"created_by_actor_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_secret_versions_identity_unique" UNIQUE("organization_id","secret_id","id"),
	CONSTRAINT "workspace_secret_versions_number_unique" UNIQUE("organization_id","secret_id","version_number"),
	CONSTRAINT "workspace_secret_versions_version_positive" CHECK ("workspace_secret_versions"."version_number" > 0),
	CONSTRAINT "workspace_secret_versions_encrypted_value_object" CHECK (jsonb_typeof("workspace_secret_versions"."encrypted_value") = 'object')
);
--> statement-breakpoint
CREATE TABLE "workspace_secrets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"key" varchar(64) NOT NULL,
	"description" varchar(240),
	"current_version_number" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	"archived_by_actor_id" uuid,
	CONSTRAINT "workspace_secrets_identity_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "workspace_secrets_key_unique" UNIQUE("organization_id","key"),
	CONSTRAINT "workspace_secrets_key_format" CHECK ("workspace_secrets"."key" ~ '^[A-Z][A-Z0-9_]{0,63}$'),
	CONSTRAINT "workspace_secrets_version_positive" CHECK ("workspace_secrets"."current_version_number" > 0),
	CONSTRAINT "workspace_secrets_archive_consistent" CHECK (("workspace_secrets"."archived_at" is null) = ("workspace_secrets"."archived_by_actor_id" is null))
);
--> statement-breakpoint
ALTER TABLE "workspace_secret_audit_events" ADD CONSTRAINT "workspace_secret_audit_events_secret_fk" FOREIGN KEY ("organization_id","secret_id") REFERENCES "public"."workspace_secrets"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_secret_bindings" ADD CONSTRAINT "workspace_secret_bindings_secret_fk" FOREIGN KEY ("organization_id","secret_id") REFERENCES "public"."workspace_secrets"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_secret_versions" ADD CONSTRAINT "workspace_secret_versions_secret_fk" FOREIGN KEY ("organization_id","secret_id") REFERENCES "public"."workspace_secrets"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "workspace_secret_audit_events_history_idx" ON "workspace_secret_audit_events" USING btree ("organization_id","secret_id","occurred_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "workspace_secret_bindings_resource_idx" ON "workspace_secret_bindings" USING btree ("organization_id","resource_type","resource_id");--> statement-breakpoint
CREATE INDEX "workspace_secrets_organization_idx" ON "workspace_secrets" USING btree ("organization_id","archived_at","created_at","id");