-- Up Migration

-- Runtime roles. docker/postgres/init.sql creates them WITH LOGIN for dev; in
-- production ops creates them first. This block only guarantees they exist so
-- the GRANTs below never fail on a fresh Postgres.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'petty_api') THEN
    CREATE ROLE petty_api NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'petty_maint') THEN
    CREATE ROLE petty_maint NOLOGIN;
  END IF;
END $$;

CREATE TABLE users (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  email         text        NOT NULL,
  display_name  text        NOT NULL,
  -- Login password only. Argon2id encoded string. This is NOT the vault passphrase;
  -- the vault passphrase never reaches the server in any form.
  password_hash text        NOT NULL,
  locale        text        NOT NULL DEFAULT 'en',
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_email_lower_idx ON users (lower(email));

GRANT USAGE ON SCHEMA public TO petty_api, petty_maint;
GRANT SELECT, INSERT, UPDATE ON users TO petty_api;
-- Account deletion (Phase 12) runs as petty_maint.
GRANT SELECT, DELETE ON users TO petty_maint;

-- Down Migration
REVOKE ALL ON users FROM petty_api, petty_maint;
DROP TABLE users;
