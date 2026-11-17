-- Up Migration
-- PETTY-285: under Clerk, Clerk signs people in, so Petty counted no sign-in at all. It now counts a sign-in
-- the first time a request carries a Clerk session (the session token's `sid`). This table remembers the
-- sessions it has seen, so a restart or a second instance does not count one twice. The id is hashed and
-- the row names no account; maintenance deletes a row 30 days after a request last carried that session.
CREATE TABLE clerk_sessions_seen (
  sid_hash  bytea PRIMARY KEY,
  seen_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX clerk_sessions_seen_at_idx ON clerk_sessions_seen (seen_at);

GRANT SELECT, INSERT, UPDATE, DELETE ON clerk_sessions_seen TO petty_api;

-- Down Migration
DROP INDEX clerk_sessions_seen_at_idx;
DROP TABLE clerk_sessions_seen;
