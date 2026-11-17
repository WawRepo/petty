-- Up Migration
-- PETTY-506 (from PETTY-461): a replaced user document and a replaced or removed drawer photo are kept for
-- 30 days, like a drawer document since PETTY-183. Before, a write overwrote the only copy: a stolen session
-- without the vault key, a bug or a bad sync could destroy someone's list of trusted people, or a photo,
-- for good. The rows are ciphertext the server cannot read, with what the AAD needs to open them; the
-- person's own app opens a copy and saves it again as a normal write (it is never copied back as it was).
--
-- How many: every copy of the last 30 days, at most KEPT_NEWEST (lib/kept.ts) of the newest, plus the first
-- copy replaced on each day. A writer that replaces the same thing many times in a row (a script with a
-- stolen session) can push out only that day's copies after the first: the state from before it started
-- stays. The bound is about 40 rows per person or drawer.

CREATE TABLE user_doc_history (
  id             bigserial   PRIMARY KEY,
  user_id        uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  version        integer     NOT NULL,   -- the user document version this copy had
  schema_version integer     NOT NULL,
  nonce          bytea       NOT NULL,
  ciphertext     bytea       NOT NULL,
  written_at     timestamptz NOT NULL,   -- when this copy was written
  replaced_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX user_doc_history_user ON user_doc_history (user_id, replaced_at DESC);

CREATE TABLE drawer_photo_history (
  id             bigserial   PRIMARY KEY,
  drawer_id      uuid        NOT NULL REFERENCES drawers(id) ON DELETE CASCADE,
  author_id      uuid        NOT NULL REFERENCES users(id),
  key_version    integer     NOT NULL,
  schema_version integer     NOT NULL,
  nonce          bytea       NOT NULL,
  ciphertext     bytea       NOT NULL,
  written_at     timestamptz NOT NULL,
  replaced_at    timestamptz NOT NULL DEFAULT now(),
  replaced_by    uuid        NULL REFERENCES users(id),
  removed        boolean     NOT NULL DEFAULT false   -- a delete ended it, not a new photo
);
CREATE INDEX drawer_photo_history_drawer ON drawer_photo_history (drawer_id, replaced_at DESC);

GRANT SELECT, INSERT, DELETE ON user_doc_history, drawer_photo_history TO petty_api;
GRANT USAGE ON SEQUENCE user_doc_history_id_seq, drawer_photo_history_id_seq TO petty_api;

-- A kept photo names its author and the one who replaced it, like a kept drawer document: the tombstone of
-- either stays while the copy does (its readers check the AAD against the author). Same function as
-- migration 019, plus that one line.
CREATE OR REPLACE FUNCTION purge_tombstones() RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  t uuid;
  n integer := 0;
BEGIN
  FOR t IN
    SELECT u.id FROM users u
     WHERE u.deleted_at IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM entries x WHERE x.author_id = u.id)
       AND NOT EXISTS (SELECT 1 FROM drawer_documents x WHERE x.author_id = u.id)
       AND NOT EXISTS (SELECT 1 FROM drawer_photos x WHERE x.author_id = u.id)
       AND NOT EXISTS (SELECT 1 FROM drawer_document_history x WHERE x.author_id = u.id OR x.replaced_by = u.id)
       AND NOT EXISTS (SELECT 1 FROM drawer_photo_history x WHERE x.author_id = u.id OR x.replaced_by = u.id)
       AND NOT EXISTS (SELECT 1 FROM drawer_keys x WHERE x.user_id = u.id OR x.wrap->>'sender_id' = u.id::text)
       AND NOT EXISTS (SELECT 1 FROM drawers x WHERE x.owner_id = u.id)
       AND NOT EXISTS (SELECT 1 FROM drawer_members x WHERE x.user_id = u.id)
       AND NOT EXISTS (SELECT 1 FROM ownership_transfers x WHERE x.from_user_id = u.id OR x.to_user_id = u.id)
       AND NOT EXISTS (SELECT 1 FROM invitations x WHERE (x.inviter_id = u.id OR x.invitee_id = u.id) AND x.state = 'pending')
     FOR UPDATE OF u SKIP LOCKED
  LOOP
    BEGIN
      DELETE FROM invitations WHERE (inviter_id = t OR invitee_id = t) AND state <> 'pending';
      DELETE FROM rotations WHERE started_by = t;
      DELETE FROM join_links WHERE used_by = t;
      DELETE FROM user_keys WHERE user_id = t;
      DELETE FROM users WHERE id = t AND deleted_at IS NOT NULL;
      n := n + 1;
    EXCEPTION WHEN foreign_key_violation THEN
      NULL;
    END;
  END LOOP;
  RETURN n;
END $$;

-- Down Migration
CREATE OR REPLACE FUNCTION purge_tombstones() RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  t uuid;
  n integer := 0;
BEGIN
  FOR t IN
    SELECT u.id FROM users u
     WHERE u.deleted_at IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM entries x WHERE x.author_id = u.id)
       AND NOT EXISTS (SELECT 1 FROM drawer_documents x WHERE x.author_id = u.id)
       AND NOT EXISTS (SELECT 1 FROM drawer_photos x WHERE x.author_id = u.id)
       AND NOT EXISTS (SELECT 1 FROM drawer_document_history x WHERE x.author_id = u.id OR x.replaced_by = u.id)
       AND NOT EXISTS (SELECT 1 FROM drawer_keys x WHERE x.user_id = u.id OR x.wrap->>'sender_id' = u.id::text)
       AND NOT EXISTS (SELECT 1 FROM drawers x WHERE x.owner_id = u.id)
       AND NOT EXISTS (SELECT 1 FROM drawer_members x WHERE x.user_id = u.id)
       AND NOT EXISTS (SELECT 1 FROM ownership_transfers x WHERE x.from_user_id = u.id OR x.to_user_id = u.id)
       AND NOT EXISTS (SELECT 1 FROM invitations x WHERE (x.inviter_id = u.id OR x.invitee_id = u.id) AND x.state = 'pending')
     FOR UPDATE OF u SKIP LOCKED
  LOOP
    BEGIN
      DELETE FROM invitations WHERE (inviter_id = t OR invitee_id = t) AND state <> 'pending';
      DELETE FROM rotations WHERE started_by = t;
      DELETE FROM join_links WHERE used_by = t;
      DELETE FROM user_keys WHERE user_id = t;
      DELETE FROM users WHERE id = t AND deleted_at IS NOT NULL;
      n := n + 1;
    EXCEPTION WHEN foreign_key_violation THEN
      NULL;
    END;
  END LOOP;
  RETURN n;
END $$;
DROP TABLE drawer_photo_history;
DROP TABLE user_doc_history;
