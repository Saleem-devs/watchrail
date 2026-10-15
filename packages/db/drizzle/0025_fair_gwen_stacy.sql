CREATE FUNCTION "watchrail_location_snapshot_is_valid"("snapshot" jsonb)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT CASE
    WHEN jsonb_typeof("snapshot") <> 'array' OR jsonb_array_length("snapshot") = 0
      THEN false
    ELSE (
      SELECT
        count(*) = count(DISTINCT "location")
        AND bool_and(
          "location" IS NOT NULL
          AND (
            "location" = 'local'
            OR "location" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
          )
        )
      FROM jsonb_array_elements_text("snapshot") AS "entry"("location")
    )
  END
$$;
--> statement-breakpoint
CREATE TABLE "check_round_locations" (
	"organization_id" uuid NOT NULL,
	"round_id" uuid NOT NULL,
	"location" varchar(64) NOT NULL,
	"probe_location_id" uuid,
	"position" integer NOT NULL,
	CONSTRAINT "check_round_locations_pk" PRIMARY KEY("organization_id","round_id","location"),
	CONSTRAINT "check_round_locations_round_position_unique" UNIQUE("organization_id","round_id","position"),
	CONSTRAINT "check_round_locations_position_non_negative" CHECK ("check_round_locations"."position" >= 0),
	CONSTRAINT "check_round_locations_identity_consistent" CHECK ((
        ("check_round_locations"."location" = 'local' and "check_round_locations"."probe_location_id" is null)
        or
        ("check_round_locations"."probe_location_id" is not null and "check_round_locations"."location" = "check_round_locations"."probe_location_id"::text)
      ))
);
--> statement-breakpoint
ALTER TABLE "monitor_configuration_versions" DROP CONSTRAINT "monitor_configuration_versions_locations_non_empty";--> statement-breakpoint
ALTER TABLE "monitors" DROP CONSTRAINT "monitors_locations_non_empty";--> statement-breakpoint
ALTER TABLE "check_rounds" ADD COLUMN "contract_version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "check_rounds" ADD COLUMN "aggregation_policy_version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "check_rounds" ADD COLUMN "confirmation_policy_version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "check_rounds" ADD COLUMN "finalization_deadline_at" timestamp with time zone;--> statement-breakpoint
UPDATE "check_rounds"
SET "finalization_deadline_at" = "created_at" + interval '120 seconds';--> statement-breakpoint
ALTER TABLE "check_rounds" ALTER COLUMN "finalization_deadline_at" SET DEFAULT clock_timestamp() + interval '120 seconds';--> statement-breakpoint
ALTER TABLE "check_rounds" ALTER COLUMN "finalization_deadline_at" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "check_round_locations" ADD CONSTRAINT "check_round_locations_round_fk" FOREIGN KEY ("organization_id","round_id") REFERENCES "public"."check_rounds"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "check_round_locations" ADD CONSTRAINT "check_round_locations_probe_location_fk" FOREIGN KEY ("organization_id","probe_location_id") REFERENCES "public"."probe_locations"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
INSERT INTO "check_round_locations" (
  "organization_id",
  "round_id",
  "location",
  "probe_location_id",
  "position"
)
SELECT
  "round"."organization_id",
  "round"."id",
  "entry"."location",
  CASE WHEN "entry"."location" = 'local' THEN null ELSE "entry"."location"::uuid END,
  ("entry"."position" - 1)::integer
FROM "check_rounds" AS "round"
JOIN "monitor_configuration_versions" AS "configuration"
  ON "configuration"."id" = "round"."monitor_configuration_version_id"
  AND "configuration"."organization_id" = "round"."organization_id"
  AND "configuration"."monitor_id" = "round"."monitor_id"
CROSS JOIN LATERAL jsonb_array_elements_text("configuration"."locations")
  WITH ORDINALITY AS "entry"("location", "position");--> statement-breakpoint
ALTER TABLE "check_execution_assignments" ADD CONSTRAINT "check_execution_assignments_round_location_fk" FOREIGN KEY ("organization_id","round_id","location") REFERENCES "public"."check_round_locations"("organization_id","round_id","location") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "check_rounds" ADD CONSTRAINT "check_rounds_contract_version_supported" CHECK ("check_rounds"."contract_version" = 1);--> statement-breakpoint
ALTER TABLE "check_rounds" ADD CONSTRAINT "check_rounds_aggregation_policy_version_supported" CHECK ("check_rounds"."aggregation_policy_version" = 1);--> statement-breakpoint
ALTER TABLE "check_rounds" ADD CONSTRAINT "check_rounds_confirmation_policy_version_supported" CHECK ("check_rounds"."confirmation_policy_version" = 1);--> statement-breakpoint
ALTER TABLE "check_rounds" ADD CONSTRAINT "check_rounds_finalization_deadline_after_creation" CHECK ("check_rounds"."finalization_deadline_at" > "check_rounds"."created_at");--> statement-breakpoint
ALTER TABLE "monitor_configuration_versions" ADD CONSTRAINT "monitor_configuration_versions_locations_non_empty" CHECK (watchrail_location_snapshot_is_valid("monitor_configuration_versions"."locations"));--> statement-breakpoint
ALTER TABLE "monitors" ADD CONSTRAINT "monitors_locations_non_empty" CHECK (watchrail_location_snapshot_is_valid("monitors"."locations"));
