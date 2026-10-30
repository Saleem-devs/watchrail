CREATE TABLE "projects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" varchar(120) NOT NULL,
	"slug" varchar(63) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "projects_identity_unique" UNIQUE("id","organization_id"),
	CONSTRAINT "projects_organization_slug_unique" UNIQUE("organization_id","slug"),
	CONSTRAINT "projects_name_not_blank" CHECK (length(btrim("projects"."name")) > 0),
	CONSTRAINT "projects_slug_format" CHECK ("projects"."slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and length("projects"."slug") between 2 and 63)
);
--> statement-breakpoint
ALTER TABLE "monitors" ADD COLUMN "project_id" uuid;--> statement-breakpoint
ALTER TABLE "status_pages" ADD COLUMN "project_id" uuid;--> statement-breakpoint
INSERT INTO "projects" ("organization_id", "name", "slug")
SELECT "organization_id", 'Default project', 'default'
FROM (
	SELECT "organization_id" FROM "monitors"
	UNION
	SELECT "organization_id" FROM "status_pages"
) AS "existing_organizations"
ON CONFLICT ("organization_id", "slug") DO NOTHING;--> statement-breakpoint
UPDATE "monitors"
SET "project_id" = "projects"."id"
FROM "projects"
WHERE "projects"."organization_id" = "monitors"."organization_id"
	AND "projects"."slug" = 'default';--> statement-breakpoint
UPDATE "status_pages"
SET "project_id" = "projects"."id"
FROM "projects"
WHERE "projects"."organization_id" = "status_pages"."organization_id"
	AND "projects"."slug" = 'default';--> statement-breakpoint
ALTER TABLE "monitors" ALTER COLUMN "project_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "status_pages" ALTER COLUMN "project_id" SET NOT NULL;--> statement-breakpoint
DROP INDEX "monitors_organization_created_idx";--> statement-breakpoint
DROP INDEX "status_pages_organization_created_idx";--> statement-breakpoint
CREATE INDEX "projects_organization_created_idx" ON "projects" USING btree ("organization_id","created_at","id");--> statement-breakpoint
ALTER TABLE "monitors" ADD CONSTRAINT "monitors_project_fk" FOREIGN KEY ("project_id","organization_id") REFERENCES "public"."projects"("id","organization_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "status_pages" ADD CONSTRAINT "status_pages_project_fk" FOREIGN KEY ("project_id","organization_id") REFERENCES "public"."projects"("id","organization_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "monitors_project_created_idx" ON "monitors" USING btree ("organization_id","project_id","created_at");--> statement-breakpoint
CREATE INDEX "status_pages_project_created_idx" ON "status_pages" USING btree ("organization_id","project_id","created_at","id");
