#!/bin/sh
# Runs once, when the Docker volume is first created. Creates the app's login role; the
# migrations grant it exactly what it may do (and REVOKE what it may not on audit_events).
set -e
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<SQL
DO \$\$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ap_app') THEN
    CREATE ROLE ap_app LOGIN PASSWORD '${AP_APP_PASSWORD:-ap_app_local}';
  END IF;
END \$\$;
SQL
