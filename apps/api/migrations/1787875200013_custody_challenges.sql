-- Up Migration
-- PETTY-334: custody challenges (security review SR-2) move from one process's memory into the database,
-- so any instance can check a challenge another one issued — the public instance runs two machines, and
-- every custody-guarded action failed with 403 whenever its two requests met different machines.
-- One outstanding challenge per user, five minutes, single use: the check deletes the row it reads.
CREATE TABLE custody_challenges (
  user_id    uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  challenge  text NOT NULL,
  expires_at timestamptz NOT NULL
);

GRANT SELECT, INSERT, UPDATE, DELETE ON custody_challenges TO petty_api;

-- Down Migration
DROP TABLE custody_challenges;
