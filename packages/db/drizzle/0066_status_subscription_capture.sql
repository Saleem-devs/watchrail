-- Lock publication before reading eligibility; fresh statements after a waiting lock see the committed publication state.
CREATE OR REPLACE FUNCTION capture_status_incident_email() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM p.id FROM status_pages p JOIN status_page_incidents i
    ON i.status_page_id = p.id AND i.organization_id = p.organization_id
    WHERE i.id = NEW.incident_id AND i.organization_id = NEW.organization_id
    ORDER BY p.id FOR SHARE OF p;
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
CREATE OR REPLACE FUNCTION capture_monitor_status_email() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM p.id FROM status_pages p WHERE p.organization_id = NEW.organization_id
    AND EXISTS (SELECT 1 FROM status_page_components c WHERE c.status_page_id = p.id
      AND c.organization_id = p.organization_id AND c.monitor_id = NEW.monitor_id)
    ORDER BY p.id FOR SHARE OF p;
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
CREATE OR REPLACE FUNCTION capture_maintenance_status_email() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM p.id FROM status_pages p WHERE p.project_id = NEW.project_id
    AND p.organization_id = NEW.organization_id ORDER BY p.id FOR SHARE OF p;
  INSERT INTO status_page_email_events (organization_id, status_page_id, source_key, subject, body)
  SELECT p.organization_id, p.id, 'maintenance:' || NEW.id,
    CASE NEW.action::text WHEN 'CREATED' THEN 'Maintenance scheduled' WHEN 'ARCHIVED' THEN 'Maintenance cancelled' ELSE 'Maintenance updated' END || ' — ' || v.name,
    CASE NEW.action::text WHEN 'ARCHIVED' THEN 'This maintenance schedule has been archived.' ELSE
      CASE v.schedule->>'type' WHEN 'ONE_TIME' THEN 'Scheduled from ' || (v.schedule->>'startsAt') || ' until ' || (v.schedule->>'endsAt')
      ELSE 'Recurring maintenance on ' || (SELECT string_agg((ARRAY['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'])[day::int + 1], ', ' ORDER BY day::int) FROM jsonb_array_elements_text(v.schedule->'daysOfWeek') AS days(day)) || ' at ' || (v.schedule->>'localTime') || ' (' || (v.schedule->>'timezone') || '), duration ' || (v.schedule->>'durationMinutes') || ' minutes. Effective from ' || coalesce(v.schedule->>'startsOn', 'no start date') || ' until ' || coalesce(v.schedule->>'endsOn', 'no end date') || '.' END END
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
