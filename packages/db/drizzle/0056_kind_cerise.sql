ALTER TABLE "notification_deliveries" DROP CONSTRAINT "notification_deliveries_event_endpoint_unique";--> statement-breakpoint
ALTER TABLE "notification_deliveries" ADD COLUMN "delivery_sequence" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "incident_reminder_delays_minutes" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_event_endpoint_sequence_unique" UNIQUE("organization_id","event_id","endpoint_id","delivery_sequence");--> statement-breakpoint
ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_sequence_non_negative" CHECK ("notification_deliveries"."delivery_sequence" between 0 and 3);--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_incident_reminder_delays_valid" CHECK (jsonb_typeof("projects"."incident_reminder_delays_minutes") = 'array'
        and jsonb_array_length("projects"."incident_reminder_delays_minutes") <= 3
        and not jsonb_path_exists(
          "projects"."incident_reminder_delays_minutes",
          '$[*] ? (@.type() != "number" || @ < 5 || @ > 10080 || @ != @.floor())'
        )
        and (
          jsonb_array_length("projects"."incident_reminder_delays_minutes") < 2
          or jsonb_path_match("projects"."incident_reminder_delays_minutes", '$[0] < $[1]')
        )
        and (
          jsonb_array_length("projects"."incident_reminder_delays_minutes") < 3
          or jsonb_path_match("projects"."incident_reminder_delays_minutes", '$[1] < $[2]')
        ));
