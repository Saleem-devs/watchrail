ALTER TABLE "check_execution_results" DROP CONSTRAINT "check_execution_results_response_evidence_consistent";--> statement-breakpoint
ALTER TABLE "check_execution_results" ADD CONSTRAINT "check_execution_results_response_evidence_consistent" CHECK ((
        (("check_execution_results"."status_code" is null) = ("check_execution_results"."response_time_ms" is null))
        or
        ("check_execution_results"."status_code" is null and "check_execution_results"."response_time_ms" is not null and "check_execution_results"."stage" = 'CONNECT' and "check_execution_results"."reason" = 'CONNECTED')
      ));