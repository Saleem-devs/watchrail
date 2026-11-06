CREATE TYPE "public"."notification_channel_type" AS ENUM('WEBHOOK', 'EMAIL');--> statement-breakpoint
ALTER TYPE "public"."notification_event_type" ADD VALUE 'TEST';--> statement-breakpoint
ALTER TABLE "notification_events" DROP CONSTRAINT "notification_events_payload_contract";--> statement-breakpoint
ALTER TABLE "webhook_endpoint_versions" DROP CONSTRAINT "webhook_endpoint_versions_url_length";--> statement-breakpoint
ALTER TABLE "webhook_endpoint_versions" DROP CONSTRAINT "webhook_endpoint_versions_secret_object";--> statement-breakpoint
ALTER TABLE "webhook_endpoint_versions" DROP CONSTRAINT "webhook_endpoint_versions_endpoint_fk";
--> statement-breakpoint
ALTER TABLE "notification_events" ALTER COLUMN "monitor_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "notification_events" ALTER COLUMN "incident_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "notification_events" ALTER COLUMN "triggering_round_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "webhook_endpoint_versions" ALTER COLUMN "url" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "webhook_endpoint_versions" ALTER COLUMN "signing_secret_envelope" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "webhook_endpoint_versions" ADD COLUMN "channel_type" "notification_channel_type" DEFAULT 'WEBHOOK' NOT NULL;--> statement-breakpoint
ALTER TABLE "webhook_endpoint_versions" ADD COLUMN "recipient_emails" jsonb;--> statement-breakpoint
ALTER TABLE "webhook_endpoints" ADD COLUMN "channel_type" "notification_channel_type" DEFAULT 'WEBHOOK' NOT NULL;--> statement-breakpoint
ALTER TABLE "webhook_endpoints" ADD CONSTRAINT "webhook_endpoints_typed_identity_unique" UNIQUE("organization_id","id","channel_type");--> statement-breakpoint
ALTER TABLE "webhook_endpoint_versions" ADD CONSTRAINT "webhook_endpoint_versions_endpoint_fk" FOREIGN KEY ("organization_id","endpoint_id","channel_type") REFERENCES "public"."webhook_endpoints"("organization_id","id","channel_type") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_events" ADD CONSTRAINT "notification_events_payload_contract" CHECK (jsonb_typeof("notification_events"."payload") = 'object'
        and "notification_events"."payload"->>'contractVersion' = '1'
        and "notification_events"."payload"->>'eventId' = "notification_events"."id"::text
        and "notification_events"."payload"->>'organizationId' = "notification_events"."organization_id"::text
        and "notification_events"."payload"->>'eventType' = "notification_events"."event_type"::text
        and (
          ("notification_events"."event_type"::text = 'TEST' and "notification_events"."monitor_id" is null and "notification_events"."incident_id" is null
            and "notification_events"."triggering_round_id" is null and "notification_events"."payload"->'channel' is not null)
          or
          ("notification_events"."event_type"::text <> 'TEST' and "notification_events"."monitor_id" is not null and "notification_events"."incident_id" is not null
            and "notification_events"."triggering_round_id" is not null
            and "notification_events"."payload"->>'triggeringRoundId' = "notification_events"."triggering_round_id"::text)
        ));--> statement-breakpoint
ALTER TABLE "webhook_endpoint_versions" ADD CONSTRAINT "webhook_endpoint_versions_configuration" CHECK ((
        "webhook_endpoint_versions"."channel_type" = 'WEBHOOK'
        and length("webhook_endpoint_versions"."url") between 1 and 2048
        and jsonb_typeof("webhook_endpoint_versions"."signing_secret_envelope") = 'object'
        and "webhook_endpoint_versions"."recipient_emails" is null
      ) or (
        "webhook_endpoint_versions"."channel_type" = 'EMAIL'
        and "webhook_endpoint_versions"."url" is null
        and "webhook_endpoint_versions"."signing_secret_envelope" is null
        and jsonb_typeof("webhook_endpoint_versions"."recipient_emails") = 'array'
        and jsonb_array_length("webhook_endpoint_versions"."recipient_emails") between 1 and 20
      ));
