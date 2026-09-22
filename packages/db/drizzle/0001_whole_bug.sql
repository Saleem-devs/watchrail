CREATE TYPE "public"."check_round_status" AS ENUM('PENDING');--> statement-breakpoint
CREATE TYPE "public"."check_round_trigger" AS ENUM('MANUAL');--> statement-breakpoint
CREATE TYPE "public"."execution_assignment_status" AS ENUM('PENDING');--> statement-breakpoint
CREATE TABLE "check_execution_assignments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"round_id" uuid NOT NULL,
	"location" varchar(64) DEFAULT 'local' NOT NULL,
	"status" "execution_assignment_status" DEFAULT 'PENDING' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "check_execution_assignments_round_location_unique" UNIQUE("round_id","location"),
	CONSTRAINT "check_execution_assignments_location_local" CHECK ("check_execution_assignments"."location" = 'local')
);
--> statement-breakpoint
CREATE TABLE "check_round_outbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"round_id" uuid NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"published_at" timestamp with time zone,
	CONSTRAINT "check_round_outbox_round_unique" UNIQUE("round_id"),
	CONSTRAINT "check_round_outbox_payload_contract" CHECK (
        jsonb_typeof("check_round_outbox"."payload") = 'object'
        and "check_round_outbox"."payload"->>'contractVersion' = '1'
        and "check_round_outbox"."payload"->>'roundId' = "check_round_outbox"."round_id"::text
        and ("check_round_outbox"."payload" - 'contractVersion' - 'roundId') = '{}'::jsonb
      )
);
--> statement-breakpoint
CREATE TABLE "check_rounds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"monitor_id" uuid NOT NULL,
	"monitor_configuration_version_id" uuid NOT NULL,
	"trigger" "check_round_trigger" DEFAULT 'MANUAL' NOT NULL,
	"status" "check_round_status" DEFAULT 'PENDING' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "check_rounds_organization_id_unique" UNIQUE("organization_id","id")
);
--> statement-breakpoint
CREATE TABLE "monitor_configuration_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"monitor_id" uuid NOT NULL,
	"version_number" integer NOT NULL,
	"url" text NOT NULL,
	"method" "http_method" NOT NULL,
	"timeout_ms" integer NOT NULL,
	"locations" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "monitor_configuration_versions_monitor_version_unique" UNIQUE("monitor_id","version_number"),
	CONSTRAINT "monitor_configuration_versions_identity_unique" UNIQUE("id","organization_id","monitor_id"),
	CONSTRAINT "monitor_configuration_versions_version_positive" CHECK ("monitor_configuration_versions"."version_number" > 0),
	CONSTRAINT "monitor_configuration_versions_url_length" CHECK (length("monitor_configuration_versions"."url") <= 2048),
	CONSTRAINT "monitor_configuration_versions_timeout_range" CHECK ("monitor_configuration_versions"."timeout_ms" between 1000 and 30000),
	CONSTRAINT "monitor_configuration_versions_locations_non_empty" CHECK (
        jsonb_typeof("monitor_configuration_versions"."locations") = 'array'
        and jsonb_array_length("monitor_configuration_versions"."locations") > 0
      )
);
INSERT INTO "monitor_configuration_versions" (
  "organization_id",
  "monitor_id",
  "version_number",
  "url",
  "method",
  "timeout_ms",
  "locations",
  "created_at"
)
SELECT
  "organization_id",
  "id",
  1,
  "url",
  "method",
  "timeout_ms",
  "locations",
  "created_at"
FROM "monitors";
--> statement-breakpoint
ALTER TABLE "monitors" ADD CONSTRAINT "monitors_id_organization_unique" UNIQUE("id","organization_id");--> statement-breakpoint
ALTER TABLE "check_execution_assignments" ADD CONSTRAINT "check_execution_assignments_round_fk" FOREIGN KEY ("organization_id","round_id") REFERENCES "public"."check_rounds"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "check_round_outbox" ADD CONSTRAINT "check_round_outbox_round_fk" FOREIGN KEY ("round_id") REFERENCES "public"."check_rounds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "check_rounds" ADD CONSTRAINT "check_rounds_monitor_fk" FOREIGN KEY ("monitor_id","organization_id") REFERENCES "public"."monitors"("id","organization_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "check_rounds" ADD CONSTRAINT "check_rounds_configuration_version_fk" FOREIGN KEY ("monitor_configuration_version_id","organization_id","monitor_id") REFERENCES "public"."monitor_configuration_versions"("id","organization_id","monitor_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "monitor_configuration_versions" ADD CONSTRAINT "monitor_configuration_versions_monitor_fk" FOREIGN KEY ("monitor_id","organization_id") REFERENCES "public"."monitors"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "check_round_outbox_unpublished_idx" ON "check_round_outbox" USING btree ("created_at") WHERE "check_round_outbox"."published_at" is null;--> statement-breakpoint
CREATE INDEX "check_rounds_monitor_created_idx" ON "check_rounds" USING btree ("organization_id","monitor_id","created_at");--> statement-breakpoint
CREATE INDEX "monitor_configuration_versions_latest_idx" ON "monitor_configuration_versions" USING btree ("organization_id","monitor_id","version_number");--> statement-breakpoint
