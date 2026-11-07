ALTER TABLE "projects" RENAME COLUMN "incident_reminder_delays_minutes" TO "incident_escalation_steps";--> statement-breakpoint
ALTER TABLE "projects" DROP CONSTRAINT "projects_incident_reminder_delays_valid";--> statement-breakpoint
UPDATE "projects"
SET "incident_escalation_steps" = COALESCE(
  (
    SELECT jsonb_agg(
      jsonb_build_object('delayMinutes', reminder.delay_minutes, 'channelIds', null)
      ORDER BY reminder.position
    )
    FROM jsonb_array_elements("projects"."incident_escalation_steps")
      WITH ORDINALITY AS reminder(delay_minutes, position)
  ),
  '[]'::jsonb
);--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_incident_escalation_steps_valid" CHECK (jsonb_typeof("projects"."incident_escalation_steps") = 'array'
        and jsonb_array_length("projects"."incident_escalation_steps") <= 3
        and not jsonb_path_exists(
          "projects"."incident_escalation_steps",
          '$[*] ? (@.type() != "object" || @.delayMinutes.type() != "number" || @.delayMinutes < 5 || @.delayMinutes > 10080 || @.delayMinutes != @.delayMinutes.floor() || (@.channelIds != null && @.channelIds.type() != "array"))'
        )
        and (
          jsonb_array_length("projects"."incident_escalation_steps") < 2
          or jsonb_path_match("projects"."incident_escalation_steps", '$[0].delayMinutes < $[1].delayMinutes')
        )
        and (
          jsonb_array_length("projects"."incident_escalation_steps") < 3
          or jsonb_path_match("projects"."incident_escalation_steps", '$[1].delayMinutes < $[2].delayMinutes')
        ));
