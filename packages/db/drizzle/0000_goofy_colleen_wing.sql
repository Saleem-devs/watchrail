CREATE TYPE "public"."http_method" AS ENUM('GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS');--> statement-breakpoint
CREATE TYPE "public"."monitor_lifecycle_state" AS ENUM('ENABLED', 'PAUSED', 'ARCHIVED');--> statement-breakpoint
CREATE TABLE "monitors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" varchar(120) NOT NULL,
	"url" text NOT NULL,
	"method" "http_method" DEFAULT 'GET' NOT NULL,
	"lifecycle_state" "monitor_lifecycle_state" DEFAULT 'ENABLED' NOT NULL,
	"timeout_ms" integer DEFAULT 10000 NOT NULL,
	"locations" jsonb DEFAULT '["local"]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "monitors_name_not_blank" CHECK (length(btrim("monitors"."name")) > 0),
	CONSTRAINT "monitors_url_length" CHECK (length("monitors"."url") <= 2048),
	CONSTRAINT "monitors_timeout_range" CHECK ("monitors"."timeout_ms" between 1000 and 30000),
	CONSTRAINT "monitors_locations_non_empty" CHECK (jsonb_typeof("monitors"."locations") = 'array' and jsonb_array_length("monitors"."locations") > 0)
);
--> statement-breakpoint
CREATE INDEX "monitors_organization_created_idx" ON "monitors" USING btree ("organization_id","created_at");