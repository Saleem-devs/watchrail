CREATE TABLE "check_regional_evaluations" (
	"organization_id" uuid NOT NULL,
	"round_id" uuid NOT NULL,
	"location" varchar(64) NOT NULL,
	"phase" varchar(32) DEFAULT 'AWAITING_PRIMARY' NOT NULL,
	"outcome" varchar(32),
	"terminal_reason" varchar(32),
	"primary_execution_id" uuid,
	"confirmation_execution_id" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "check_regional_evaluations_pk" PRIMARY KEY("organization_id","round_id","location"),
	CONSTRAINT "check_regional_evaluations_phase_valid" CHECK ("check_regional_evaluations"."phase" in ('AWAITING_PRIMARY', 'AWAITING_CONFIRMATION', 'TERMINAL')),
	CONSTRAINT "check_regional_evaluations_outcome_valid" CHECK ("check_regional_evaluations"."outcome" is null or "check_regional_evaluations"."outcome" in ('PASS', 'CONFIRMED_FAIL', 'UNKNOWN')),
	CONSTRAINT "check_regional_evaluations_terminal_consistent" CHECK (("check_regional_evaluations"."phase" = 'TERMINAL') = ("check_regional_evaluations"."outcome" is not null and "check_regional_evaluations"."terminal_reason" is not null))
);
--> statement-breakpoint
CREATE TABLE "check_regional_executions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"round_id" uuid NOT NULL,
	"assignment_id" uuid NOT NULL,
	"location" varchar(64) NOT NULL,
	"agent_id" varchar(128) NOT NULL,
	"role" varchar(16) NOT NULL,
	"observation" jsonb NOT NULL,
	"accepted_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "check_regional_executions_identity_unique" UNIQUE("organization_id","round_id","location","id"),
	CONSTRAINT "check_regional_executions_role_unique" UNIQUE("organization_id","round_id","location","role"),
	CONSTRAINT "check_regional_executions_role_valid" CHECK ("check_regional_executions"."role" in ('PRIMARY', 'CONFIRMATION')),
	CONSTRAINT "check_regional_executions_observation_object" CHECK (jsonb_typeof("check_regional_executions"."observation") = 'object')
);
--> statement-breakpoint
CREATE TABLE "check_round_aggregates" (
	"organization_id" uuid NOT NULL,
	"round_id" uuid NOT NULL,
	"outcome" varchar(16) NOT NULL,
	"aggregate" jsonb NOT NULL,
	"finalized_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "check_round_aggregates_pk" PRIMARY KEY("organization_id","round_id"),
	CONSTRAINT "check_round_aggregates_outcome_valid" CHECK ("check_round_aggregates"."outcome" in ('UP', 'DEGRADED', 'DOWN', 'UNKNOWN')),
	CONSTRAINT "check_round_aggregates_payload_object" CHECK (jsonb_typeof("check_round_aggregates"."aggregate") = 'object')
);
--> statement-breakpoint
ALTER TABLE "incidents" ADD COLUMN "severity" varchar(16);--> statement-breakpoint
ALTER TABLE "monitor_incident_state" ADD COLUMN "multi_location_severity" varchar(16);--> statement-breakpoint
ALTER TABLE "monitor_incident_state" ADD COLUMN "multi_location_healthy_recovery_streak" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "check_execution_assignments" ADD CONSTRAINT "check_execution_assignments_regional_identity_unique" UNIQUE("organization_id","round_id","id","location");--> statement-breakpoint
ALTER TABLE "check_regional_evaluations" ADD CONSTRAINT "check_regional_evaluations_round_location_fk" FOREIGN KEY ("organization_id","round_id","location") REFERENCES "public"."check_round_locations"("organization_id","round_id","location") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "check_regional_evaluations" ADD CONSTRAINT "check_regional_evaluations_primary_execution_fk" FOREIGN KEY ("organization_id","round_id","location","primary_execution_id") REFERENCES "public"."check_regional_executions"("organization_id","round_id","location","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "check_regional_evaluations" ADD CONSTRAINT "check_regional_evaluations_confirmation_execution_fk" FOREIGN KEY ("organization_id","round_id","location","confirmation_execution_id") REFERENCES "public"."check_regional_executions"("organization_id","round_id","location","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "check_regional_executions" ADD CONSTRAINT "check_regional_executions_assignment_fk" FOREIGN KEY ("organization_id","round_id","assignment_id","location") REFERENCES "public"."check_execution_assignments"("organization_id","round_id","id","location") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "check_regional_executions" ADD CONSTRAINT "check_regional_executions_round_location_fk" FOREIGN KEY ("organization_id","round_id","location") REFERENCES "public"."check_round_locations"("organization_id","round_id","location") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "check_round_aggregates" ADD CONSTRAINT "check_round_aggregates_round_fk" FOREIGN KEY ("organization_id","round_id") REFERENCES "public"."check_rounds"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incidents" ADD CONSTRAINT "incidents_severity_valid" CHECK ("incidents"."severity" is null or "incidents"."severity" in ('DEGRADED', 'DOWN'));--> statement-breakpoint
ALTER TABLE "monitor_incident_state" ADD CONSTRAINT "monitor_incident_state_multi_location_severity_valid" CHECK ("monitor_incident_state"."multi_location_severity" is null or "monitor_incident_state"."multi_location_severity" in ('DEGRADED', 'DOWN'));--> statement-breakpoint
ALTER TABLE "monitor_incident_state" ADD CONSTRAINT "monitor_incident_state_multi_location_recovery_valid" CHECK ("monitor_incident_state"."multi_location_healthy_recovery_streak" between 0 and 1 and ("monitor_incident_state"."multi_location_severity" is not null or "monitor_incident_state"."multi_location_healthy_recovery_streak" = 0));
