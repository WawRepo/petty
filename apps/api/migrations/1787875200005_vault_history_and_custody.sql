-- Up Migration
-- Security review SR-2: a replaced vault is kept for 30 days so an admin can put
-- it back. Ciphertext only (the same blobs users.vault / users.recovery_vault
-- held), never keys. Rows are deleted with the account and purged by the API's
-- hourly maintenance after 30 days.
CREATE TABLE vault_history (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  vault          jsonb       NOT NULL,
  recovery_vault jsonb,
  replaced_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX vault_history_user_idx ON vault_history (user_id, replaced_at DESC);

GRANT SELECT, INSERT, DELETE ON vault_history TO petty_api;

-- Down Migration
DROP TABLE vault_history;
