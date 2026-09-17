-- Up Migration
-- Phase 15a: admin flag, blocking, and login-password reset tokens.
-- None of this touches vault blobs: a reset changes the login password only.
ALTER TABLE users ADD COLUMN is_admin   boolean     NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN blocked_at timestamptz;

CREATE TABLE password_resets (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash bytea       NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  used_at    timestamptz
);
GRANT SELECT, INSERT, UPDATE ON password_resets TO petty_api;

-- Down Migration
DROP TABLE password_resets;
ALTER TABLE users DROP COLUMN blocked_at;
ALTER TABLE users DROP COLUMN is_admin;
