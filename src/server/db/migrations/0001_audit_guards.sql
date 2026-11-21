-- Audit log guards (docs/rules/db.md: "audit_events is append-only. No update or delete path").
--
-- Two independent locks, so one mistake does not open history:
--   1. a trigger that rejects UPDATE / DELETE / TRUNCATE for EVERY role, the owner included;
--   2. the app's role `ap_app` is never granted UPDATE / DELETE / TRUNCATE on audit_events, and
--      may INSERT only the columns it should set — not `id` or `occurred_at`, so it cannot backdate.
--
-- `ap_app` is created NOLOGIN here so the migration runs anywhere (Docker, Supabase, PGlite tests).
-- Locally docker/init/01-roles.sql creates it first WITH a login; on Supabase run once:
--   ALTER ROLE ap_app LOGIN PASSWORD '<secret>';

CREATE OR REPLACE FUNCTION audit_events_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_events is append-only: % is not allowed', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER audit_events_no_update_delete
  BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION audit_events_immutable();
--> statement-breakpoint
CREATE TRIGGER audit_events_no_truncate
  BEFORE TRUNCATE ON audit_events
  FOR EACH STATEMENT EXECUTE FUNCTION audit_events_immutable();
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ap_app') THEN
    CREATE ROLE ap_app NOLOGIN;
  END IF;
END
$$;
--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO ap_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ap_app;
--> statement-breakpoint
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ap_app;
--> statement-breakpoint
-- History: read it, append to it (chosen columns only), never change it.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON audit_events FROM ap_app;
--> statement-breakpoint
GRANT INSERT (request_id, actor_id, actor_role, on_behalf_of, action, entity_type, entity_id,
              invoice_id, payment_id, before, after, reason, metadata)
  ON audit_events TO ap_app;
--> statement-breakpoint
-- Tables added by later migrations get the same grants automatically. A later migration that
-- adds another append-only table must REVOKE on it explicitly, like above.
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ap_app;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO ap_app;
