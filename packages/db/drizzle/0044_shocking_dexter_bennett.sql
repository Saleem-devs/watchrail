CREATE TABLE "webhook_endpoint_monitor_routes" (
	"organization_id" uuid NOT NULL,
	"endpoint_id" uuid NOT NULL,
	"monitor_id" uuid NOT NULL,
	"notify_on_incident" boolean DEFAULT true NOT NULL,
	"notify_on_recovery" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "webhook_endpoint_monitor_routes_pk" PRIMARY KEY("organization_id","endpoint_id","monitor_id")
);
--> statement-breakpoint
ALTER TABLE "webhook_endpoints" ADD COLUMN "project_id" uuid;--> statement-breakpoint
ALTER TABLE "webhook_endpoint_monitor_routes" ADD CONSTRAINT "webhook_endpoint_monitor_routes_endpoint_fk" FOREIGN KEY ("organization_id","endpoint_id") REFERENCES "public"."webhook_endpoints"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_endpoint_monitor_routes" ADD CONSTRAINT "webhook_endpoint_monitor_routes_monitor_fk" FOREIGN KEY ("monitor_id","organization_id") REFERENCES "public"."monitors"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "webhook_endpoint_monitor_routes_monitor_idx" ON "webhook_endpoint_monitor_routes" USING btree ("organization_id","monitor_id","endpoint_id");--> statement-breakpoint
ALTER TABLE "webhook_endpoints" ADD CONSTRAINT "webhook_endpoints_project_fk" FOREIGN KEY ("project_id","organization_id") REFERENCES "public"."projects"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "webhook_endpoints_project_idx" ON "webhook_endpoints" USING btree ("organization_id","project_id","created_at","id");