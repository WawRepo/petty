-- Up Migration
-- PETTY-184 (review NR-4): a writing token signs entries with its own ECDSA key, never the account
-- key. The account key signs a delegation for it; readers verify entries against the token key only
-- after checking that delegation against the author's account key. The server stores both in the
-- clear (they are public) and cannot forge a delegation. revoked_at tells readers when it stopped.
ALTER TABLE access_tokens
  ADD COLUMN ecdsa_pub  text  NULL,
  ADD COLUMN sig_key_id text  NULL,
  ADD COLUMN delegation jsonb NULL;
CREATE UNIQUE INDEX access_tokens_sig_key ON access_tokens (user_id, sig_key_id) WHERE sig_key_id IS NOT NULL;

-- Down Migration
DROP INDEX access_tokens_sig_key;
ALTER TABLE access_tokens DROP COLUMN delegation, DROP COLUMN sig_key_id, DROP COLUMN ecdsa_pub;
