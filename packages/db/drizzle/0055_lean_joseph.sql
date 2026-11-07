ALTER TABLE "notification_events" DROP CONSTRAINT "notification_events_payload_contract";--> statement-breakpoint
ALTER TABLE "notification_events" ADD CONSTRAINT "notification_events_payload_contract" CHECK (jsonb_typeof("notification_events"."payload") = 'object'
        and "notification_events"."payload"->>'contractVersion' in ('1', '2')
        and "notification_events"."payload"->>'eventId' = "notification_events"."id"::text
        and "notification_events"."payload"->>'organizationId' = "notification_events"."organization_id"::text
        and "notification_events"."payload"->>'eventType' = "notification_events"."event_type"::text
        and (
          ("notification_events"."event_type"::text = 'TEST' and "notification_events"."payload"->>'contractVersion' = '1'
            and "notification_events"."monitor_id" is null and "notification_events"."incident_id" is null
            and "notification_events"."triggering_round_id" is null and "notification_events"."payload"->'channel' is not null)
          or
          ("notification_events"."event_type"::text <> 'TEST' and "notification_events"."monitor_id" is not null and "notification_events"."incident_id" is not null
            and "notification_events"."triggering_round_id" is not null
            and "notification_events"."payload"->>'triggeringRoundId' = "notification_events"."triggering_round_id"::text
            and (
              "notification_events"."payload"->>'contractVersion' = '1'
              or (
                "notification_events"."payload"->>'contractVersion' = '2'
                and "notification_events"."payload"->'incident'->>'groupKey' is not null
                and "notification_events"."payload"->'incident'->>'severity' in ('DEGRADED', 'DOWN')
              )
            ))
        ));