CREATE TYPE "public"."incident_action" AS ENUM('ACKNOWLEDGED', 'SILENCED', 'UNSILENCED', 'MANUALLY_RESOLVED');--> statement-breakpoint
CREATE TABLE "incident_action_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"incident_id" uuid NOT NULL,
	"actor_id" uuid NOT NULL,
	"action" "incident_action" NOT NULL,
	"silence_until" timestamp with time zone,
	"note" varchar(500),
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "incident_action_events_payload_consistent" CHECK ((
        ("incident_action_events"."action" = 'SILENCED' and "incident_action_events"."silence_until" is not null and "incident_action_events"."note" is null)
        or ("incident_action_events"."action" = 'MANUALLY_RESOLVED' and "incident_action_events"."silence_until" is null)
        or ("incident_action_events"."action" in ('ACKNOWLEDGED', 'UNSILENCED') and "incident_action_events"."silence_until" is null and "incident_action_events"."note" is null)
      ))
);
--> statement-breakpoint
ALTER TABLE "incidents" DROP CONSTRAINT "incidents_resolution_consistent";--> statement-breakpoint
ALTER TABLE "incidents" ADD COLUMN "resolved_by_actor_id" uuid;--> statement-breakpoint
ALTER TABLE "incidents" ADD COLUMN "resolution_note" varchar(500);--> statement-breakpoint
ALTER TABLE "incidents" ADD COLUMN "acknowledged_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "incidents" ADD COLUMN "acknowledged_by_actor_id" uuid;--> statement-breakpoint
ALTER TABLE "incidents" ADD COLUMN "silenced_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "incidents" ADD COLUMN "silenced_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "incidents" ADD COLUMN "silenced_by_actor_id" uuid;--> statement-breakpoint
ALTER TABLE "incident_action_events" ADD CONSTRAINT "incident_action_events_incident_fk" FOREIGN KEY ("organization_id","incident_id") REFERENCES "public"."incidents"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "incident_action_events_history_idx" ON "incident_action_events" USING btree ("organization_id","incident_id","occurred_at","id");--> statement-breakpoint
ALTER TABLE "incidents" ADD CONSTRAINT "incidents_acknowledgement_consistent" CHECK (("incidents"."acknowledged_at" is null) = ("incidents"."acknowledged_by_actor_id" is null));--> statement-breakpoint
ALTER TABLE "incidents" ADD CONSTRAINT "incidents_silence_consistent" CHECK (num_nonnulls("incidents"."silenced_at", "incidents"."silenced_until", "incidents"."silenced_by_actor_id") in (0, 3) and ("incidents"."silenced_at" is null or "incidents"."silenced_until" > "incidents"."silenced_at"));--> statement-breakpoint
ALTER TABLE "incidents" ADD CONSTRAINT "incidents_resolution_consistent" CHECK (("incidents"."status" = 'RESOLVED') = ("incidents"."resolved_at" is not null and num_nonnulls("incidents"."resolved_by_round_id", "incidents"."resolved_by_actor_id") = 1));