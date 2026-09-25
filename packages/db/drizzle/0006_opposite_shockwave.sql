ALTER TABLE "monitor_configuration_versions" ADD COLUMN "status_policy" jsonb DEFAULT '{"type":"ANY_2XX"}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "monitors" ADD COLUMN "status_policy" jsonb DEFAULT '{"type":"ANY_2XX"}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "monitor_configuration_versions" ADD CONSTRAINT "monitor_configuration_versions_status_policy_shape" CHECK (
        jsonb_typeof("monitor_configuration_versions"."status_policy") = 'object'
        and "monitor_configuration_versions"."status_policy"->>'type' in ('ANY_2XX', 'EXACT')
        and (
          "monitor_configuration_versions"."status_policy"->>'type' = 'ANY_2XX'
          or (
            jsonb_typeof("monitor_configuration_versions"."status_policy"->'statusCodes') = 'array'
            and jsonb_array_length("monitor_configuration_versions"."status_policy"->'statusCodes') > 0
            and not jsonb_path_exists(
              "monitor_configuration_versions"."status_policy",
              '$.statusCodes[*] ? (@.type() != "number" || @ != @.floor() || @ < 100 || @ > 599)'
            )
          )
        )
      );--> statement-breakpoint
ALTER TABLE "monitors" ADD CONSTRAINT "monitors_status_policy_shape" CHECK (
        jsonb_typeof("monitors"."status_policy") = 'object'
        and "monitors"."status_policy"->>'type' in ('ANY_2XX', 'EXACT')
        and (
          "monitors"."status_policy"->>'type' = 'ANY_2XX'
          or (
            jsonb_typeof("monitors"."status_policy"->'statusCodes') = 'array'
            and jsonb_array_length("monitors"."status_policy"->'statusCodes') > 0
            and not jsonb_path_exists(
              "monitors"."status_policy",
              '$.statusCodes[*] ? (@.type() != "number" || @ != @.floor() || @ < 100 || @ > 599)'
            )
          )
        )
      );