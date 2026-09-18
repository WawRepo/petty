-- Up Migration
-- PETTY-183 (review NR-3): every document write keeps the sealed document it replaced for 30 days,
-- so a bad or hostile write (for example from a leaked write token) can be undone by the owner.
-- The rows are ciphertext the server cannot read, with the author and key version the AAD needs.
CREATE TABLE drawer_document_history (
  id             bigserial   PRIMARY KEY,
  drawer_id      uuid        NOT NULL REFERENCES drawers(id) ON DELETE CASCADE,
  version        integer     NOT NULL,   -- the drawer version this document had
  author_id      uuid        NOT NULL REFERENCES users(id),
  key_version    integer     NOT NULL,
  schema_version integer     NOT NULL,
  nonce          bytea       NOT NULL,
  ciphertext     bytea       NOT NULL,
  written_at     timestamptz NOT NULL,   -- when this document was written
  replaced_at    timestamptz NOT NULL DEFAULT now(),
  replaced_by    uuid        NULL REFERENCES users(id),
  replaced_by_token uuid     NULL REFERENCES access_tokens(id) ON DELETE SET NULL
);
CREATE INDEX drawer_document_history_drawer ON drawer_document_history (drawer_id, replaced_at DESC);

GRANT SELECT, INSERT, DELETE ON drawer_document_history TO petty_api;
GRANT USAGE ON SEQUENCE drawer_document_history_id_seq TO petty_api;
GRANT SELECT, DELETE ON drawer_document_history TO petty_maint;

-- Down Migration
DROP TABLE drawer_document_history;
