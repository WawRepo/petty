#!/bin/sh
# Creates the two runtime roles with the passwords from the environment (first start only).
# Migrations run as the owner and only GRANT to these roles.
set -eu
psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
  -v api_pw="$PETTY_API_PASSWORD" -v maint_pw="$PETTY_MAINT_PASSWORD" <<'SQL'
CREATE ROLE petty_api   LOGIN PASSWORD :'api_pw';
CREATE ROLE petty_maint LOGIN PASSWORD :'maint_pw';
SQL
