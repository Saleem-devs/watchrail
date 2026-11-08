CREATE TABLE "dns_record_changes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"monitor_id" uuid NOT NULL,
	"configuration_version_id" uuid NOT NULL,
	"dns_name" varchar(253) NOT NULL,
	"record_type" varchar(8) NOT NULL,
	"before_answers" jsonb NOT NULL,
	"after_answers" jsonb NOT NULL,
	"before_location_evidence" jsonb NOT NULL,
	"after_location_evidence" jsonb NOT NULL,
	"detected_at" timestamp with time zone NOT NULL,
	"confirmed_at" timestamp with time zone NOT NULL,
	"first_observed_round_id" uuid NOT NULL,
	"confirmed_round_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "dns_record_changes_confirmed_round_unique" UNIQUE("organization_id","monitor_id","confirmed_round_id"),
	CONSTRAINT "dns_record_changes_answers_arrays" CHECK (jsonb_typeof("dns_record_changes"."before_answers") = 'array' and jsonb_array_length("dns_record_changes"."before_answers") <= 32
        and jsonb_typeof("dns_record_changes"."after_answers") = 'array' and jsonb_array_length("dns_record_changes"."after_answers") <= 32),
	CONSTRAINT "dns_record_changes_evidence_arrays" CHECK (jsonb_typeof("dns_record_changes"."before_location_evidence") = 'array'
        and jsonb_typeof("dns_record_changes"."after_location_evidence") = 'array'),
	CONSTRAINT "dns_record_changes_time_order" CHECK ("dns_record_changes"."detected_at" <= "dns_record_changes"."confirmed_at")
);
--> statement-breakpoint
CREATE TABLE "dns_record_history_state" (
	"organization_id" uuid NOT NULL,
	"monitor_id" uuid PRIMARY KEY NOT NULL,
	"configuration_version_id" uuid NOT NULL,
	"dns_name" varchar(253) NOT NULL,
	"record_type" varchar(8) NOT NULL,
	"baseline_answers" jsonb NOT NULL,
	"baseline_location_evidence" jsonb NOT NULL,
	"baseline_observed_at" timestamp with time zone NOT NULL,
	"baseline_round_id" uuid NOT NULL,
	"candidate_answers" jsonb,
	"candidate_location_evidence" jsonb,
	"candidate_first_observed_at" timestamp with time zone,
	"candidate_round_id" uuid,
	"last_processed_round_created_at" timestamp with time zone NOT NULL,
	"last_processed_round_id" uuid NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "dns_record_history_state_baseline_answers_array" CHECK (jsonb_typeof("dns_record_history_state"."baseline_answers") = 'array' and jsonb_array_length("dns_record_history_state"."baseline_answers") <= 32),
	CONSTRAINT "dns_record_history_state_baseline_evidence_array" CHECK (jsonb_typeof("dns_record_history_state"."baseline_location_evidence") = 'array'),
	CONSTRAINT "dns_record_history_state_candidate_consistent" CHECK (("dns_record_history_state"."candidate_answers" is null) = ("dns_record_history_state"."candidate_location_evidence" is null)
        and ("dns_record_history_state"."candidate_answers" is null) = ("dns_record_history_state"."candidate_first_observed_at" is null)
        and ("dns_record_history_state"."candidate_answers" is null) = ("dns_record_history_state"."candidate_round_id" is null)),
	CONSTRAINT "dns_record_history_state_candidate_answers_array" CHECK ("dns_record_history_state"."candidate_answers" is null or (jsonb_typeof("dns_record_history_state"."candidate_answers") = 'array' and jsonb_array_length("dns_record_history_state"."candidate_answers") <= 32)),
	CONSTRAINT "dns_record_history_state_candidate_evidence_array" CHECK ("dns_record_history_state"."candidate_location_evidence" is null or jsonb_typeof("dns_record_history_state"."candidate_location_evidence") = 'array')
);
--> statement-breakpoint
ALTER TABLE "dns_record_changes" ADD CONSTRAINT "dns_record_changes_monitor_fk" FOREIGN KEY ("monitor_id","organization_id") REFERENCES "public"."monitors"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dns_record_changes" ADD CONSTRAINT "dns_record_changes_configuration_fk" FOREIGN KEY ("configuration_version_id","organization_id","monitor_id") REFERENCES "public"."monitor_configuration_versions"("id","organization_id","monitor_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dns_record_changes" ADD CONSTRAINT "dns_record_changes_first_round_fk" FOREIGN KEY ("organization_id","first_observed_round_id") REFERENCES "public"."check_rounds"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dns_record_changes" ADD CONSTRAINT "dns_record_changes_confirmed_round_fk" FOREIGN KEY ("organization_id","confirmed_round_id") REFERENCES "public"."check_rounds"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dns_record_history_state" ADD CONSTRAINT "dns_record_history_state_monitor_fk" FOREIGN KEY ("monitor_id","organization_id") REFERENCES "public"."monitors"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dns_record_history_state" ADD CONSTRAINT "dns_record_history_state_configuration_fk" FOREIGN KEY ("configuration_version_id","organization_id","monitor_id") REFERENCES "public"."monitor_configuration_versions"("id","organization_id","monitor_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "dns_record_changes_monitor_confirmed_idx" ON "dns_record_changes" USING btree ("organization_id","monitor_id","confirmed_at","id");