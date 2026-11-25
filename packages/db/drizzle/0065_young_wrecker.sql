CREATE TABLE "status_page_email_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"status_page_id" uuid NOT NULL,
	"subscriber_id" uuid NOT NULL,
	"generation" uuid NOT NULL,
	"event_id" uuid,
	"kind" text NOT NULL,
	"encrypted_payload" jsonb,
	"state" text DEFAULT 'PENDING' NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_expires_at" timestamp with time zone,
	"claim_token" uuid,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"last_error_code" text,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "status_email_delivery_event" UNIQUE("subscriber_id","generation","event_id"),
	CONSTRAINT "status_email_delivery_kind" CHECK (("status_page_email_deliveries"."kind" = 'VERIFY' and "status_page_email_deliveries"."event_id" is null and "status_page_email_deliveries"."encrypted_payload" is not null) or ("status_page_email_deliveries"."kind" = 'EVENT' and "status_page_email_deliveries"."event_id" is not null)),
	CONSTRAINT "status_email_delivery_state" CHECK ("status_page_email_deliveries"."state" in ('PENDING', 'SENDING', 'DELIVERED', 'SUPPRESSED', 'DEAD'))
);
--> statement-breakpoint
CREATE TABLE "status_page_email_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"status_page_id" uuid NOT NULL,
	"source_key" text NOT NULL,
	"subject" text NOT NULL,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	"expanded_at" timestamp with time zone,
	CONSTRAINT "status_email_event_source" UNIQUE("status_page_id","source_key"),
	CONSTRAINT "status_email_event_identity" UNIQUE("id","status_page_id","organization_id")
);
--> statement-breakpoint
CREATE TABLE "status_page_subscribers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"status_page_id" uuid NOT NULL,
	"email_hash" text NOT NULL,
	"encrypted_details" jsonb NOT NULL,
	"generation" uuid NOT NULL,
	"state" text DEFAULT 'PENDING' NOT NULL,
	"verification_hash" text NOT NULL,
	"unsubscribe_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"confirmed_at" timestamp with time zone,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "status_subscriber_page_email" UNIQUE("status_page_id","email_hash"),
	CONSTRAINT "status_subscriber_identity" UNIQUE("id","status_page_id","organization_id"),
	CONSTRAINT "status_subscriber_verify_token" UNIQUE("verification_hash"),
	CONSTRAINT "status_subscriber_unsubscribe_token" UNIQUE("unsubscribe_hash"),
	CONSTRAINT "status_subscriber_state" CHECK ("status_page_subscribers"."state" in ('PENDING', 'ACTIVE', 'UNSUBSCRIBED'))
);
--> statement-breakpoint
CREATE TABLE "status_page_subscription_limits" (
	"key" text PRIMARY KEY NOT NULL,
	"count" integer NOT NULL,
	"resets_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "status_page_email_deliveries" ADD CONSTRAINT "status_page_email_deliveries_subscriber_id_status_page_id_organization_id_status_page_subscribers_id_status_page_id_organization_id_fk" FOREIGN KEY ("subscriber_id","status_page_id","organization_id") REFERENCES "public"."status_page_subscribers"("id","status_page_id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "status_page_email_deliveries" ADD CONSTRAINT "status_page_email_deliveries_event_id_status_page_id_organization_id_status_page_email_events_id_status_page_id_organization_id_fk" FOREIGN KEY ("event_id","status_page_id","organization_id") REFERENCES "public"."status_page_email_events"("id","status_page_id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "status_page_email_events" ADD CONSTRAINT "status_page_email_events_status_page_id_organization_id_status_pages_id_organization_id_fk" FOREIGN KEY ("status_page_id","organization_id") REFERENCES "public"."status_pages"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "status_page_subscribers" ADD CONSTRAINT "status_page_subscribers_status_page_id_organization_id_status_pages_id_organization_id_fk" FOREIGN KEY ("status_page_id","organization_id") REFERENCES "public"."status_pages"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "status_email_delivery_due" ON "status_page_email_deliveries" USING btree ("state","available_at");--> statement-breakpoint
CREATE INDEX "status_email_event_pending" ON "status_page_email_events" USING btree ("expanded_at","created_at");--> statement-breakpoint
-- Public notification snapshots are captured transactionally, independently of operator alert suppression.
CREATE FUNCTION capture_status_incident_email() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO status_page_email_events (organization_id, status_page_id, source_key, subject, body)
  SELECT p.organization_id, p.id, 'manual:' || NEW.id,
    CASE WHEN NEW.state = 'RESOLVED' THEN 'Incident resolved' WHEN NEW.sequence = 1 THEN 'Incident opened' ELSE 'Incident update' END || ' — ' || i.title,
    NEW.state::text || E'\n\n' || NEW.message || E'\n\nAffected services: ' ||
    coalesce((SELECT string_agg(c.display_name, ', ' ORDER BY c.position) FROM status_page_incident_components c
      WHERE c.incident_id = i.id AND c.organization_id = i.organization_id), '')
  FROM status_page_incidents i JOIN status_pages p ON p.id = i.status_page_id AND p.organization_id = i.organization_id
  WHERE i.id = NEW.incident_id AND i.organization_id = NEW.organization_id AND p.published
  ON CONFLICT DO NOTHING;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER status_incident_email AFTER INSERT ON status_page_incident_updates FOR EACH ROW EXECUTE FUNCTION capture_status_incident_email();
--> statement-breakpoint
CREATE FUNCTION capture_monitor_status_email() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.status IS NOT DISTINCT FROM OLD.status THEN RETURN NEW; END IF;
  INSERT INTO status_page_email_events (organization_id, status_page_id, source_key, subject, body)
  SELECT p.organization_id, p.id, 'monitor:' || NEW.id || ':' || NEW.status,
    CASE WHEN NEW.status = 'OPEN' THEN 'Incident opened' ELSE 'Incident resolved' END || ' — ' || c.display_name,
    CASE WHEN NEW.status = 'OPEN' THEN 'A monitoring incident has been confirmed for ' || c.display_name || '.'
      WHEN NEW.resolved_by_actor_id IS NOT NULL THEN 'An operator closed the incident for ' || c.display_name || '. This does not establish service recovery.'
      ELSE 'The monitoring incident for ' || c.display_name || ' has resolved.' END
  FROM status_page_components c JOIN status_pages p ON p.id = c.status_page_id AND p.organization_id = c.organization_id
  WHERE c.monitor_id = NEW.monitor_id AND c.organization_id = NEW.organization_id AND p.published
  ON CONFLICT DO NOTHING;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER monitor_status_email AFTER INSERT OR UPDATE OF status ON incidents FOR EACH ROW EXECUTE FUNCTION capture_monitor_status_email();
--> statement-breakpoint
CREATE FUNCTION capture_maintenance_status_email() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO status_page_email_events (organization_id, status_page_id, source_key, subject, body)
  SELECT p.organization_id, p.id, 'maintenance:' || NEW.id,
    CASE NEW.action::text WHEN 'CREATED' THEN 'Maintenance scheduled' WHEN 'ARCHIVED' THEN 'Maintenance cancelled' ELSE 'Maintenance updated' END || ' — ' || v.name,
    CASE NEW.action::text WHEN 'ARCHIVED' THEN 'This maintenance schedule has been archived.' ELSE
      CASE v.schedule->>'type' WHEN 'ONE_TIME' THEN 'Scheduled from ' || (v.schedule->>'startsAt') || ' until ' || (v.schedule->>'endsAt')
      ELSE 'Recurring maintenance at ' || (v.schedule->>'localTime') || ' (' || (v.schedule->>'timezone') || '), duration ' || (v.schedule->>'durationMinutes') || ' minutes.' END END
  FROM maintenance_window_versions v
  JOIN status_pages p ON p.project_id = NEW.project_id AND p.organization_id = NEW.organization_id
  WHERE v.maintenance_window_id = NEW.maintenance_window_id AND v.organization_id = NEW.organization_id AND v.version_number = NEW.version_number
    AND p.published AND (v.effects->>'publishToStatusPage')::boolean
    AND (v.target_type = 'PROJECT' OR EXISTS (SELECT 1 FROM maintenance_window_version_monitors m
      JOIN status_page_components c ON c.monitor_id = m.monitor_id AND c.organization_id = m.organization_id AND c.status_page_id = p.id
      WHERE m.maintenance_window_version_id = v.id AND m.organization_id = v.organization_id))
  ON CONFLICT DO NOTHING;
  -- Withdraw previously public schedules from pages removed by an edit, without leaking the new private configuration.
  IF NEW.action::text = 'UPDATED' THEN
    INSERT INTO status_page_email_events (organization_id, status_page_id, source_key, subject, body)
    SELECT p.organization_id, p.id, 'maintenance-withdrawn:' || NEW.id,
      'Maintenance publication withdrawn — ' || previous.name,
      'This maintenance schedule is no longer published for this status page.'
    FROM maintenance_window_versions previous
    JOIN maintenance_window_versions current ON current.maintenance_window_id = previous.maintenance_window_id
      AND current.organization_id = previous.organization_id AND current.version_number = NEW.version_number
    JOIN status_pages p ON p.project_id = NEW.project_id AND p.organization_id = NEW.organization_id
    WHERE previous.maintenance_window_id = NEW.maintenance_window_id AND previous.organization_id = NEW.organization_id
      AND previous.version_number = NEW.version_number - 1 AND p.published AND (previous.effects->>'publishToStatusPage')::boolean
      AND (previous.target_type = 'PROJECT' OR EXISTS (SELECT 1 FROM maintenance_window_version_monitors m
        JOIN status_page_components c ON c.monitor_id = m.monitor_id AND c.organization_id = m.organization_id AND c.status_page_id = p.id
        WHERE m.maintenance_window_version_id = previous.id AND m.organization_id = previous.organization_id))
      AND (NOT (current.effects->>'publishToStatusPage')::boolean OR NOT (current.target_type = 'PROJECT' OR EXISTS (
        SELECT 1 FROM maintenance_window_version_monitors m JOIN status_page_components c
          ON c.monitor_id = m.monitor_id AND c.organization_id = m.organization_id AND c.status_page_id = p.id
        WHERE m.maintenance_window_version_id = current.id AND m.organization_id = current.organization_id)))
    ON CONFLICT DO NOTHING;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER maintenance_status_email AFTER INSERT ON maintenance_window_audit_events FOR EACH ROW EXECUTE FUNCTION capture_maintenance_status_email();
--> statement-breakpoint
CREATE FUNCTION suppress_unpublished_status_email() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.published AND NOT NEW.published THEN
    UPDATE status_page_email_deliveries SET state = 'SUPPRESSED', completed_at = clock_timestamp(), claim_token = null
      WHERE status_page_id = NEW.id AND state IN ('PENDING', 'SENDING');
    UPDATE status_page_email_events SET expanded_at = clock_timestamp() WHERE status_page_id = NEW.id AND expanded_at IS NULL;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER unpublished_status_email AFTER UPDATE OF published ON status_pages FOR EACH ROW EXECUTE FUNCTION suppress_unpublished_status_email();
