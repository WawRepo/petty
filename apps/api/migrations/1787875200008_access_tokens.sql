-- Up Migration
-- PETTY-164: access tokens for the owner's own tools (a Claude Desktop MCP server, a script).
-- The token string is `petty_pat_<id>.<secret>`. Only `<id>` is ever sent here, and only its
-- SHA-256 is stored. `<secret>` never reaches the server: it derives the key that opens
-- `bundle_ciphertext`, which holds the drawer keys the owner chose (and the signing key for a
-- writing token). The server therefore stores a key bundle it cannot open, exactly like a vault.
CREATE TABLE access_tokens (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name          text NOT NULL,
  token_hash    bytea NOT NULL UNIQUE,
  role          text NOT NULL CHECK (role IN ('read', 'write')),
  -- NULL means every drawer the user is a member of; otherwise exactly these drawer ids.
  scope         uuid[] NULL,
  bundle_nonce      text NOT NULL,
  bundle_ciphertext text NOT NULL,
  schema_version int NOT NULL DEFAULT 1,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_used_at  timestamptz NULL,
  expires_at    timestamptz NULL,
  revoked_at    timestamptz NULL
);
CREATE INDEX access_tokens_user_idx ON access_tokens (user_id, created_at DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON access_tokens TO petty_api;

-- Down Migration
DROP INDEX access_tokens_user_idx;
DROP TABLE access_tokens;
