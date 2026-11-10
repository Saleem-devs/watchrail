CREATE TYPE "public"."status_page_incident_impact" AS ENUM('DEGRADED', 'DOWN');--> statement-breakpoint
CREATE TYPE "public"."status_page_incident_state" AS ENUM('INVESTIGATING', 'IDENTIFIED', 'MONITORING', 'RESOLVED');--> statement-breakpoint
CREATE TABLE "status_page_incident_components" (
	"organization_id" uuid NOT NULL,
	"incident_id" uuid NOT NULL,
	"component_id" uuid NOT NULL,
	"display_name" varchar(100) NOT NULL,
	"position" integer NOT NULL,
	CONSTRAINT "status_page_incident_components_pk" PRIMARY KEY("organization_id","incident_id","component_id"),
	CONSTRAINT "status_page_incident_components_position_unique" UNIQUE("organization_id","incident_id","position"),
	CONSTRAINT "status_page_incident_components_name_not_blank" CHECK (length(btrim("status_page_incident_components"."display_name")) > 0),
	CONSTRAINT "status_page_incident_components_position_non_negative" CHECK ("status_page_incident_components"."position" >= 0)
);
--> statement-breakpoint
CREATE TABLE "status_page_incident_updates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"incident_id" uuid NOT NULL,
	"sequence" integer NOT NULL,
	"state" "status_page_incident_state" NOT NULL,
	"message" varchar(2000) NOT NULL,
	"created_by_actor_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "status_page_incident_updates_identity_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "status_page_incident_updates_sequence_unique" UNIQUE("organization_id","incident_id","sequence"),
	CONSTRAINT "status_page_incident_updates_sequence_positive" CHECK ("status_page_incident_updates"."sequence" > 0),
	CONSTRAINT "status_page_incident_updates_message_not_blank" CHECK (length(btrim("status_page_incident_updates"."message")) > 0)
);
--> statement-breakpoint
CREATE TABLE "status_page_incidents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"status_page_id" uuid NOT NULL,
	"title" varchar(160) NOT NULL,
	"impact" "status_page_incident_impact" NOT NULL,
	"state" "status_page_incident_state" DEFAULT 'INVESTIGATING' NOT NULL,
	"created_by_actor_id" uuid NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "status_page_incidents_identity_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "status_page_incidents_title_not_blank" CHECK (length(btrim("status_page_incidents"."title")) > 0),
	CONSTRAINT "status_page_incidents_resolution_consistent" CHECK (("status_page_incidents"."state" = 'RESOLVED') = ("status_page_incidents"."resolved_at" is not null))
);
--> statement-breakpoint
ALTER TABLE "status_page_incident_components" ADD CONSTRAINT "status_page_incident_components_incident_fk" FOREIGN KEY ("organization_id","incident_id") REFERENCES "public"."status_page_incidents"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "status_page_incident_updates" ADD CONSTRAINT "status_page_incident_updates_incident_fk" FOREIGN KEY ("organization_id","incident_id") REFERENCES "public"."status_page_incidents"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "status_page_incidents" ADD CONSTRAINT "status_page_incidents_page_fk" FOREIGN KEY ("status_page_id","organization_id") REFERENCES "public"."status_pages"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "status_page_incident_updates_timeline_idx" ON "status_page_incident_updates" USING btree ("organization_id","incident_id","sequence");--> statement-breakpoint
CREATE INDEX "status_page_incidents_page_started_idx" ON "status_page_incidents" USING btree ("organization_id","status_page_id","started_at","id");