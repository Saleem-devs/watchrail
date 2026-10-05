CREATE TYPE "public"."notification_event_type" AS ENUM('INCIDENT_OPENED', 'INCIDENT_RESOLVED');--> statement-breakpoint
CREATE TABLE "notification_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"event_id" uuid NOT NULL,
	"endpoint_id" uuid NOT NULL,
	"endpoint_version_id" uuid NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"claim_token" uuid,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"last_attempt_at" timestamp with time zone,
	"last_error_code" varchar(64),
	"last_http_status" integer,
	"delivered_at" timestamp with time zone,
	"dead_at" timestamp with time zone,
	"dead_reason" varchar(64),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notification_deliveries_event_endpoint_unique" UNIQUE("organization_id","event_id","endpoint_id"),
	CONSTRAINT "notification_deliveries_attempt_count_non_negative" CHECK ("notification_deliveries"."attempt_count" >= 0),
	CONSTRAINT "notification_deliveries_http_status_range" CHECK ("notification_deliveries"."last_http_status" is null or "notification_deliveries"."last_http_status" between 100 and 599),
	CONSTRAINT "notification_deliveries_one_terminal_state" CHECK (not ("notification_deliveries"."delivered_at" is not null and "notification_deliveries"."dead_at" is not null)),
	CONSTRAINT "notification_deliveries_dead_fields_consistent" CHECK (("notification_deliveries"."dead_at" is null) = ("notification_deliveries"."dead_reason" is null)),
	CONSTRAINT "notification_deliveries_terminal_claim_cleared" CHECK (("notification_deliveries"."delivered_at" is null and "notification_deliveries"."dead_at" is null) or "notification_deliveries"."claim_token" is null)
);
--> statement-breakpoint
CREATE TABLE "notification_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"monitor_id" uuid NOT NULL,
	"incident_id" uuid NOT NULL,
	"event_type" "notification_event_type" NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"triggering_round_id" uuid NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notification_events_identity_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "notification_events_incident_type_unique" UNIQUE("organization_id","incident_id","event_type"),
	CONSTRAINT "notification_events_payload_contract" CHECK (jsonb_typeof("notification_events"."payload") = 'object' and "notification_events"."payload"->>'contractVersion' = '1' and "notification_events"."payload"->>'eventId' = "notification_events"."id"::text and "notification_events"."payload"->>'organizationId' = "notification_events"."organization_id"::text and "notification_events"."payload"->>'eventType' = "notification_events"."event_type"::text and "notification_events"."payload"->>'triggeringRoundId' = "notification_events"."triggering_round_id"::text)
);
--> statement-breakpoint
CREATE TABLE "webhook_endpoint_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"endpoint_id" uuid NOT NULL,
	"version_number" integer NOT NULL,
	"url" text NOT NULL,
	"signing_secret_envelope" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "webhook_endpoint_versions_identity_unique" UNIQUE("organization_id","endpoint_id","id"),
	CONSTRAINT "webhook_endpoint_versions_number_unique" UNIQUE("organization_id","endpoint_id","version_number"),
	CONSTRAINT "webhook_endpoint_versions_version_positive" CHECK ("webhook_endpoint_versions"."version_number" > 0),
	CONSTRAINT "webhook_endpoint_versions_url_length" CHECK (length("webhook_endpoint_versions"."url") between 1 and 2048),
	CONSTRAINT "webhook_endpoint_versions_secret_object" CHECK (jsonb_typeof("webhook_endpoint_versions"."signing_secret_envelope") = 'object')
);
--> statement-breakpoint
CREATE TABLE "webhook_endpoints" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" varchar(120) NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"current_version_number" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "webhook_endpoints_identity_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "webhook_endpoints_name_not_blank" CHECK (length(btrim("webhook_endpoints"."name")) > 0),
	CONSTRAINT "webhook_endpoints_version_positive" CHECK ("webhook_endpoints"."current_version_number" > 0)
);
--> statement-breakpoint
ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_event_fk" FOREIGN KEY ("organization_id","event_id") REFERENCES "public"."notification_events"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_endpoint_fk" FOREIGN KEY ("organization_id","endpoint_id") REFERENCES "public"."webhook_endpoints"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_endpoint_version_fk" FOREIGN KEY ("organization_id","endpoint_id","endpoint_version_id") REFERENCES "public"."webhook_endpoint_versions"("organization_id","endpoint_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_events" ADD CONSTRAINT "notification_events_monitor_fk" FOREIGN KEY ("monitor_id","organization_id") REFERENCES "public"."monitors"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_events" ADD CONSTRAINT "notification_events_incident_fk" FOREIGN KEY ("organization_id","incident_id") REFERENCES "public"."incidents"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_events" ADD CONSTRAINT "notification_events_round_fk" FOREIGN KEY ("organization_id","triggering_round_id") REFERENCES "public"."check_rounds"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_endpoint_versions" ADD CONSTRAINT "webhook_endpoint_versions_endpoint_fk" FOREIGN KEY ("organization_id","endpoint_id") REFERENCES "public"."webhook_endpoints"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "notification_deliveries_eligible_idx" ON "notification_deliveries" USING btree ("available_at","created_at","id") WHERE "notification_deliveries"."delivered_at" is null and "notification_deliveries"."dead_at" is null;