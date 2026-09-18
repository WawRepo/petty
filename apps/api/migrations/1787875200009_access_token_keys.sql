-- Up Migration
-- PETTY-169: an access token gets its own ECDH key pair, so drawers reach it the way they reach a
-- member: one wrapped drawer key per drawer and key version. The public half is stored here in the
-- clear (it is public); the private half lives only inside the token's sealed bundle.
ALTER TABLE access_tokens ADD COLUMN ecdh_pub text NULL;

CREATE TABLE access_token_keys (
  token_id    uuid        NOT NULL REFERENCES access_tokens(id) ON DELETE CASCADE,
  drawer_id   uuid        NOT NULL REFERENCES drawers(id) ON DELETE CASCADE,
  key_version integer     NOT NULL,
  wrap        jsonb       NOT NULL,   -- DrawerKeyWrapV1, made by the owner for the token's public key
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (token_id, drawer_id, key_version)
);

GRANT SELECT, INSERT, DELETE ON access_token_keys TO petty_api;

-- Down Migration
DROP TABLE access_token_keys;
ALTER TABLE access_tokens DROP COLUMN ecdh_pub;
