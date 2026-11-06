CREATE TYPE "public"."maintenance_window_audit_action" AS ENUM('CREATED', 'UPDATED', 'ARCHIVED');--> statement-breakpoint
CREATE TABLE "maintenance_window_audit_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"maintenance_window_id" uuid NOT NULL,
	"action" "maintenance_window_audit_action" NOT NULL,
	"version_number" integer NOT NULL,
	"actor_id" uuid NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "maintenance_window_audit_events_version_positive" CHECK ("maintenance_window_audit_events"."version_number" > 0)
);
--> statement-breakpoint
CREATE TABLE "maintenance_window_version_monitors" (
	"organization_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"maintenance_window_version_id" uuid NOT NULL,
	"monitor_id" uuid NOT NULL,
	CONSTRAINT "maintenance_window_version_monitors_pk" PRIMARY KEY("organization_id","maintenance_window_version_id","monitor_id")
);
--> statement-breakpoint
CREATE TABLE "maintenance_window_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"maintenance_window_id" uuid NOT NULL,
	"version_number" integer NOT NULL,
	"name" varchar(100) NOT NULL,
	"schedule" jsonb NOT NULL,
	"target_type" varchar(16) NOT NULL,
	"effects" jsonb NOT NULL,
	"effective_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by_actor_id" uuid NOT NULL,
	CONSTRAINT "maintenance_window_versions_identity_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "maintenance_window_versions_project_identity_unique" UNIQUE("organization_id","project_id","id"),
	CONSTRAINT "maintenance_window_versions_number_unique" UNIQUE("organization_id","maintenance_window_id","version_number"),
	CONSTRAINT "maintenance_window_versions_number_positive" CHECK ("maintenance_window_versions"."version_number" > 0),
	CONSTRAINT "maintenance_window_versions_name_not_blank" CHECK (length(btrim("maintenance_window_versions"."name")) > 0),
	CONSTRAINT "maintenance_window_versions_schedule_object" CHECK (jsonb_typeof("maintenance_window_versions"."schedule") = 'object'),
	CONSTRAINT "maintenance_window_versions_target_valid" CHECK ("maintenance_window_versions"."target_type" in ('PROJECT', 'MONITORS')),
	CONSTRAINT "maintenance_window_versions_effects_object" CHECK (jsonb_typeof("maintenance_window_versions"."effects") = 'object')
);
--> statement-breakpoint
CREATE TABLE "maintenance_windows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"current_version_number" integer DEFAULT 1 NOT NULL,
	"created_by_actor_id" uuid NOT NULL,
	"archived_at" timestamp with time zone,
	"archived_by_actor_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "maintenance_windows_identity_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "maintenance_windows_project_identity_unique" UNIQUE("organization_id","project_id","id"),
	CONSTRAINT "maintenance_windows_current_version_positive" CHECK ("maintenance_windows"."current_version_number" > 0),
	CONSTRAINT "maintenance_windows_archive_consistent" CHECK (("maintenance_windows"."archived_at" is null) = ("maintenance_windows"."archived_by_actor_id" is null))
);
--> statement-breakpoint
ALTER TABLE "maintenance_window_audit_events" ADD CONSTRAINT "maintenance_window_audit_events_window_fk" FOREIGN KEY ("organization_id","project_id","maintenance_window_id") REFERENCES "public"."maintenance_windows"("organization_id","project_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "monitors" ADD CONSTRAINT "monitors_project_identity_unique" UNIQUE("id","organization_id","project_id");--> statement-breakpoint
ALTER TABLE "maintenance_window_version_monitors" ADD CONSTRAINT "maintenance_window_version_monitors_version_fk" FOREIGN KEY ("organization_id","project_id","maintenance_window_version_id") REFERENCES "public"."maintenance_window_versions"("organization_id","project_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maintenance_window_version_monitors" ADD CONSTRAINT "maintenance_window_version_monitors_monitor_fk" FOREIGN KEY ("monitor_id","organization_id","project_id") REFERENCES "public"."monitors"("id","organization_id","project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maintenance_window_versions" ADD CONSTRAINT "maintenance_window_versions_window_fk" FOREIGN KEY ("organization_id","project_id","maintenance_window_id") REFERENCES "public"."maintenance_windows"("organization_id","project_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maintenance_windows" ADD CONSTRAINT "maintenance_windows_project_fk" FOREIGN KEY ("project_id","organization_id") REFERENCES "public"."projects"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "maintenance_window_audit_events_history_idx" ON "maintenance_window_audit_events" USING btree ("organization_id","project_id","maintenance_window_id","occurred_at","id");--> statement-breakpoint
CREATE INDEX "maintenance_window_version_monitors_monitor_idx" ON "maintenance_window_version_monitors" USING btree ("organization_id","project_id","monitor_id","maintenance_window_version_id");--> statement-breakpoint
CREATE INDEX "maintenance_window_versions_effective_idx" ON "maintenance_window_versions" USING btree ("organization_id","project_id","effective_at","id");--> statement-breakpoint
CREATE INDEX "maintenance_windows_project_created_idx" ON "maintenance_windows" USING btree ("organization_id","project_id","created_at","id");
