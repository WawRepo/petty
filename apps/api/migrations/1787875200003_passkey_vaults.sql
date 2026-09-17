-- Up Migration
-- Phase 14: passkey (WebAuthn PRF) unlock. A third wrapped copy of the user's
-- private keys, openable only with the PRF output of one specific passkey.
-- Everything here is public or ciphertext; the server never sees the PRF output.
CREATE TABLE passkey_vaults (
  user_id       uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  credential_id text NOT NULL,
  prf_salt      text NOT NULL,
  vault         jsonb NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON passkey_vaults TO petty_api;

-- Down Migration
REVOKE ALL ON passkey_vaults FROM petty_api;
DROP TABLE passkey_vaults;
