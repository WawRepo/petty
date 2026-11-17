-- Up Migration
-- PETTY-359: emails sealed with a server key (EMAIL_KEY, lib/email-seal.ts), so a copy of the database (a
-- leaked backup, a stolen disk or branch, an SQL injection that reads tables) shows no address. The key
-- lives only in the app's environment; this file adds the columns and changes no row.
--
-- An email is in one of two forms, never both:
--   * plain: `email` holds it, as before. Every row is plain until an instance with a key runs; an
--     instance without a key keeps writing this form.
--   * sealed: `email` is null; `email_sealed` = 0x01 || 12-byte nonce || AES-256-GCM ciphertext and tag,
--     bound to its table, column, row id and key id; `email_key_id` names the key (a value derived from
--     it, never the key); users also get `email_index`, an HMAC of the address in lower case under a key
--     derived from the same one, so a lookup by address still finds the row.
-- The app moves rows between the forms in its housekeeping run: plain to sealed when it has a key, to a
-- new key when EMAIL_KEY_OLD names the one they are under, back to plain when only EMAIL_KEY_OLD is set.
--
-- users_email_lower_idx (unique, on lower(email)) stays: plain rows can exist at any time (an instance
-- without a key, an older instance during a rollout, rows the run has not reached), and a sealed row has
-- no `email`, so the index never sees it. Sealed addresses are unique through users_email_index_idx.

ALTER TABLE users
  ALTER COLUMN email DROP NOT NULL,
  ADD COLUMN email_sealed bytea,
  ADD COLUMN email_key_id text,
  ADD COLUMN email_index  bytea,
  ADD CONSTRAINT users_email_one_form CHECK ((email IS NULL) <> (email_sealed IS NULL)),
  ADD CONSTRAINT users_email_sealed_whole CHECK ((email_sealed IS NULL) = (email_key_id IS NULL) AND (email_sealed IS NULL) = (email_index IS NULL));
CREATE UNIQUE INDEX users_email_index_idx ON users (email_index);

-- A join link's optional address: plain, sealed, or none (no restriction, or used and forgotten).
ALTER TABLE join_links
  ADD COLUMN email_sealed bytea,
  ADD COLUMN email_key_id text,
  ADD CONSTRAINT join_links_email_one_form CHECK (email IS NULL OR email_sealed IS NULL),
  ADD CONSTRAINT join_links_email_sealed_whole CHECK ((email_sealed IS NULL) = (email_key_id IS NULL));

-- Down Migration
-- Only while no email is sealed: run the app once with EMAIL_KEY_OLD (and no EMAIL_KEY) first, which
-- writes every address back in plain. SET NOT NULL fails if a sealed row is left.
ALTER TABLE join_links
  DROP CONSTRAINT join_links_email_sealed_whole,
  DROP CONSTRAINT join_links_email_one_form,
  DROP COLUMN email_key_id,
  DROP COLUMN email_sealed;
DROP INDEX users_email_index_idx;
ALTER TABLE users
  DROP CONSTRAINT users_email_sealed_whole,
  DROP CONSTRAINT users_email_one_form,
  DROP COLUMN email_index,
  DROP COLUMN email_key_id,
  DROP COLUMN email_sealed,
  ALTER COLUMN email SET NOT NULL;
