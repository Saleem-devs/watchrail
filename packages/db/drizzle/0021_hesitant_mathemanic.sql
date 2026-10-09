CREATE TABLE "status_page_components" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"status_page_id" uuid NOT NULL,
	"monitor_id" uuid NOT NULL,
	"display_name" varchar(100) NOT NULL,
	"position" integer NOT NULL,
	CONSTRAINT "status_page_components_page_monitor_unique" UNIQUE("status_page_id","monitor_id"),
	CONSTRAINT "status_page_components_page_position_unique" UNIQUE("status_page_id","position"),
	CONSTRAINT "status_page_components_display_name_not_blank" CHECK (length(btrim("status_page_components"."display_name")) > 0),
	CONSTRAINT "status_page_components_position_non_negative" CHECK ("status_page_components"."position" >= 0)
);
--> statement-breakpoint
CREATE TABLE "status_pages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" varchar(100) NOT NULL,
	"slug" varchar(63) NOT NULL,
	"published" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "status_pages_identity_unique" UNIQUE("id","organization_id"),
	CONSTRAINT "status_pages_slug_unique" UNIQUE("slug"),
	CONSTRAINT "status_pages_name_not_blank" CHECK (length(btrim("status_pages"."name")) > 0),
	CONSTRAINT "status_pages_slug_format" CHECK ("status_pages"."slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and length("status_pages"."slug") between 3 and 63)
);
--> statement-breakpoint
ALTER TABLE "status_page_components" ADD CONSTRAINT "status_page_components_page_fk" FOREIGN KEY ("status_page_id","organization_id") REFERENCES "public"."status_pages"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "status_page_components" ADD CONSTRAINT "status_page_components_monitor_fk" FOREIGN KEY ("monitor_id","organization_id") REFERENCES "public"."monitors"("id","organization_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "status_page_components_page_order_idx" ON "status_page_components" USING btree ("status_page_id","position");--> statement-breakpoint
CREATE INDEX "status_pages_organization_created_idx" ON "status_pages" USING btree ("organization_id","created_at","id");