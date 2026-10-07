-- Up Migration
-- PETTY-334: the request and sign-in limits (security review SR-7, PETTY-303) count in the database, not
-- in each process's memory, so several instances share one count: with two machines an address got twice
-- the sign-in attempts, and a locked-out email was free again on the other machine. The key is hashed —
-- it holds addresses and attacker-chosen emails — and a row lives one window; maintenance deletes the old.
CREATE TABLE rate_counters (
  key_hash  bytea PRIMARY KEY,
  n         int NOT NULL,
  reset_at  timestamptz NOT NULL
);
CREATE INDEX rate_counters_reset_idx ON rate_counters (reset_at);

GRANT SELECT, INSERT, UPDATE, DELETE ON rate_counters TO petty_api;

-- Down Migration
DROP INDEX rate_counters_reset_idx;
DROP TABLE rate_counters;
