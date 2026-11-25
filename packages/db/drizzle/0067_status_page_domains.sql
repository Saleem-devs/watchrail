CREATE TABLE "status_page_domains" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"status_page_id" uuid NOT NULL,
	"hostname" varchar(253) NOT NULL,
	"verification_token" text NOT NULL,
	"https_verified_at" timestamp with time zone,
	"https_error" text,
	"verified_at" timestamp with time zone,
	"routing_verified_at" timestamp with time zone,
	"check_token" uuid,
	"last_checked_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "status_page_domains_hostname_unique" UNIQUE("hostname"),
	CONSTRAINT "status_page_domain_page_unique" UNIQUE("status_page_id")
);
--> statement-breakpoint
ALTER TABLE "status_page_domains" ADD CONSTRAINT "status_page_domains_status_page_id_organization_id_status_pages_id_organization_id_fk" FOREIGN KEY ("status_page_id","organization_id") REFERENCES "public"."status_pages"("id","organization_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE FUNCTION invalidate_status_domain_https() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.published IS DISTINCT FROM NEW.published THEN
    UPDATE status_page_domains SET https_verified_at = NULL, https_error = NULL,
      last_checked_at = NULL, check_token = NULL WHERE status_page_id = NEW.id;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER status_domain_publication_changed AFTER UPDATE OF published ON status_pages
  FOR EACH ROW EXECUTE FUNCTION invalidate_status_domain_https();
