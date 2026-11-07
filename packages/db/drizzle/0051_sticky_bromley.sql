ALTER TYPE "public"."notification_channel_type" ADD VALUE 'SLACK';--> statement-breakpoint
ALTER TABLE "webhook_endpoint_versions" DROP CONSTRAINT "webhook_endpoint_versions_configuration";--> statement-breakpoint
ALTER TABLE "webhook_endpoint_versions" ADD COLUMN "slack_webhook_url_envelope" jsonb;--> statement-breakpoint
ALTER TABLE "webhook_endpoint_versions" ADD CONSTRAINT "webhook_endpoint_versions_configuration" CHECK ((
        "webhook_endpoint_versions"."channel_type"::text = 'WEBHOOK'
        and length("webhook_endpoint_versions"."url") between 1 and 2048
        and jsonb_typeof("webhook_endpoint_versions"."signing_secret_envelope") = 'object'
        and "webhook_endpoint_versions"."recipient_emails" is null
        and "webhook_endpoint_versions"."slack_webhook_url_envelope" is null
      ) or (
        "webhook_endpoint_versions"."channel_type"::text = 'EMAIL'
        and "webhook_endpoint_versions"."url" is null
        and "webhook_endpoint_versions"."signing_secret_envelope" is null
        and jsonb_typeof("webhook_endpoint_versions"."recipient_emails") = 'array'
        and jsonb_array_length("webhook_endpoint_versions"."recipient_emails") between 1 and 20
        and "webhook_endpoint_versions"."slack_webhook_url_envelope" is null
      ) or (
        "webhook_endpoint_versions"."channel_type"::text = 'SLACK'
        and "webhook_endpoint_versions"."url" is null
        and "webhook_endpoint_versions"."signing_secret_envelope" is null
        and "webhook_endpoint_versions"."recipient_emails" is null
        and jsonb_typeof("webhook_endpoint_versions"."slack_webhook_url_envelope") = 'object'
      ));
