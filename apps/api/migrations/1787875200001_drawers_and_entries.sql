-- Up Migration

-- ---------------------------------------------------------------- users
ALTER TABLE users
  ADD COLUMN vault          jsonb,          -- VaultBlobV1 (ciphertext + public keys), passphrase-wrapped
  ADD COLUMN recovery_vault jsonb,          -- VaultBlobV1, recovery-code-wrapped
  ADD COLUMN deleted_at     timestamptz;

-- Every public key a user ever published. Never deleted: old entries must keep verifying.
CREATE TABLE user_keys (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid        NOT NULL REFERENCES users(id),
  ecdh_pub    text        NOT NULL,
  ecdsa_pub   text        NOT NULL,
  sig_key_id  text        NOT NULL UNIQUE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  retired_at  timestamptz
);
CREATE UNIQUE INDEX user_keys_one_active ON user_keys (user_id) WHERE retired_at IS NULL;

CREATE TABLE sessions (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash   bytea       NOT NULL UNIQUE,
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL DEFAULT now()
);

-- Signup is invite-only (SPEC-ISSUES B10).
CREATE TABLE join_links (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash  bytea       NOT NULL UNIQUE,
  created_by  uuid        REFERENCES users(id) ON DELETE SET NULL,
  email       text,                              -- optional: restrict to one address
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  used_by     uuid        REFERENCES users(id),
  used_at     timestamptz
);

-- Per-user private document (key pins, preferences), sealed under a key only the user can derive.
CREATE TABLE user_docs (
  user_id        uuid        PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  version        integer     NOT NULL DEFAULT 1,
  schema_version integer     NOT NULL,
  nonce          bytea       NOT NULL,
  ciphertext     bytea       NOT NULL,
  updated_at     timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------- drawers
CREATE TABLE drawers (
  id               uuid        PRIMARY KEY,
  owner_id         uuid        NOT NULL REFERENCES users(id),
  version          integer     NOT NULL DEFAULT 1,   -- optimistic lock for the document
  key_version      integer     NOT NULL DEFAULT 1,   -- current drawer key generation
  last_write_at    timestamptz NOT NULL DEFAULT now(),
  last_verified_at timestamptz,                      -- set by a document write flagged as a verification
  rotation_needed  boolean     NOT NULL DEFAULT false,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX drawers_owner_idx ON drawers (owner_id);

CREATE TABLE drawer_documents (
  drawer_id      uuid        PRIMARY KEY REFERENCES drawers(id) ON DELETE CASCADE,
  author_id      uuid        NOT NULL REFERENCES users(id),
  key_version    integer     NOT NULL,
  schema_version integer     NOT NULL,
  nonce          bytea       NOT NULL,
  ciphertext     bytea       NOT NULL,
  updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE drawer_photos (
  drawer_id      uuid        PRIMARY KEY REFERENCES drawers(id) ON DELETE CASCADE,
  author_id      uuid        NOT NULL REFERENCES users(id),
  key_version    integer     NOT NULL,
  schema_version integer     NOT NULL,
  nonce          bytea       NOT NULL,
  ciphertext     bytea       NOT NULL,
  updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE drawer_members (
  drawer_id uuid        NOT NULL REFERENCES drawers(id) ON DELETE CASCADE,
  user_id   uuid        NOT NULL REFERENCES users(id),
  role      text        NOT NULL CHECK (role IN ('write', 'read')),   -- the owner is drawers.owner_id
  joined_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (drawer_id, user_id)
);
CREATE INDEX drawer_members_user_idx ON drawer_members (user_id);

-- Drawer key wrapped for one member, one row per key generation. Old rows stay for in-flight readers.
CREATE TABLE drawer_keys (
  drawer_id   uuid        NOT NULL REFERENCES drawers(id) ON DELETE CASCADE,
  user_id     uuid        NOT NULL REFERENCES users(id),
  key_version integer     NOT NULL,
  wrap        jsonb       NOT NULL,   -- DrawerKeyWrapV1
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (drawer_id, user_id, key_version)
);

CREATE TABLE invitations (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  drawer_id   uuid        NOT NULL REFERENCES drawers(id) ON DELETE CASCADE,
  inviter_id  uuid        NOT NULL REFERENCES users(id),
  invitee_id  uuid        NOT NULL REFERENCES users(id),
  role        text        NOT NULL CHECK (role IN ('write', 'read')),
  key_version integer     NOT NULL,
  wrap        jsonb       NOT NULL,   -- wrapped at invite time (SPEC-ISSUES B5)
  state       text        NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'accepted', 'declined', 'revoked')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz
);
CREATE UNIQUE INDEX invitations_one_pending ON invitations (drawer_id, invitee_id) WHERE state = 'pending';
CREATE INDEX invitations_invitee_idx ON invitations (invitee_id) WHERE state = 'pending';

CREATE TABLE ownership_transfers (
  drawer_id    uuid        PRIMARY KEY REFERENCES drawers(id) ON DELETE CASCADE,
  from_user_id uuid        NOT NULL REFERENCES users(id),
  to_user_id   uuid        NOT NULL REFERENCES users(id),
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE rotations (
  drawer_id    uuid        NOT NULL REFERENCES drawers(id) ON DELETE CASCADE,
  to_version   integer     NOT NULL,
  started_by   uuid        NOT NULL REFERENCES users(id),
  started_at   timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  PRIMARY KEY (drawer_id, to_version)
);

-- ---------------------------------------------------------------- entries
-- Per-line counters. The row lock serialises concurrent appends on one line.
CREATE TABLE line_heads (
  drawer_id      uuid   NOT NULL REFERENCES drawers(id) ON DELETE CASCADE,
  line_id        uuid   NOT NULL,
  head_seq       bigint NOT NULL DEFAULT 0,
  checkpoint_seq bigint NOT NULL DEFAULT 0,   -- seq of the latest Adjust, 0 = none
  PRIMARY KEY (drawer_id, line_id)
);

CREATE TABLE entries (
  id                uuid        PRIMARY KEY,                       -- client-assigned: replay is idempotent
  drawer_id         uuid        NOT NULL REFERENCES drawers(id) ON DELETE CASCADE,
  line_id           uuid        NOT NULL,
  seq               bigint      NOT NULL,
  author_id         uuid        NOT NULL REFERENCES users(id),
  is_checkpoint     boolean     NOT NULL,
  reverses_entry_id uuid        UNIQUE REFERENCES entries(id),     -- reverse-once (SPEC-ISSUES A4)
  key_version       integer     NOT NULL,
  schema_version    integer     NOT NULL,
  nonce             bytea       NOT NULL,
  ciphertext        bytea       NOT NULL,
  received_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (drawer_id, line_id, seq)
);
CREATE INDEX entries_drawer_key_version_idx ON entries (drawer_id, key_version);

-- Append-only, enforced (CLAUDE.md rule 8). petty_maint may rewrite ciphertext for
-- key rotation only; nothing else on the row can change, and key_version never goes down.
CREATE FUNCTION entries_rotation_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW.drawer_id <> OLD.drawer_id OR NEW.line_id <> OLD.line_id OR NEW.seq <> OLD.seq
     OR NEW.author_id <> OLD.author_id OR NEW.is_checkpoint <> OLD.is_checkpoint
     OR NEW.reverses_entry_id IS DISTINCT FROM OLD.reverses_entry_id
     OR NEW.schema_version <> OLD.schema_version OR NEW.received_at <> OLD.received_at THEN
    RAISE EXCEPTION 'entries are append-only: only ciphertext, nonce and key_version may change' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.key_version <= OLD.key_version THEN
    RAISE EXCEPTION 'entries: key_version must increase on rotation' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER entries_rotation_only BEFORE UPDATE ON entries FOR EACH ROW EXECUTE FUNCTION entries_rotation_only();

-- Every entry insert bumps the drawer's server-side last_write_at (staleness, SPEC-ISSUES B3).
-- Document and photo writes bump it explicitly in the API, so that a key-rotation
-- re-seal (which also rewrites those rows, as petty_maint) does not count as a change.
CREATE FUNCTION bump_last_write() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE drawers SET last_write_at = now() WHERE id = NEW.drawer_id;
  RETURN NEW;
END $$;
CREATE TRIGGER entries_bump_last_write AFTER INSERT ON entries FOR EACH ROW EXECUTE FUNCTION bump_last_write();

-- ---------------------------------------------------------------- deletion (petty_maint only)
-- Owned by the migration role, so callers need no DELETE privilege on the tables.
CREATE FUNCTION delete_line(p_drawer uuid, p_line uuid) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE n bigint;
BEGIN
  DELETE FROM entries WHERE drawer_id = p_drawer AND line_id = p_line;
  GET DIAGNOSTICS n = ROW_COUNT;
  DELETE FROM line_heads WHERE drawer_id = p_drawer AND line_id = p_line;
  UPDATE drawers SET last_write_at = now() WHERE id = p_drawer;
  RETURN n;
END $$;

CREATE FUNCTION delete_drawer(p_drawer uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  DELETE FROM drawers WHERE id = p_drawer;   -- cascades to documents, photos, keys, members, invitations, heads, entries
END $$;

REVOKE ALL ON FUNCTION delete_line(uuid, uuid), delete_drawer(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION delete_line(uuid, uuid), delete_drawer(uuid) TO petty_maint;

-- ---------------------------------------------------------------- grants
GRANT SELECT, INSERT, UPDATE, DELETE ON sessions, join_links, drawer_members, drawer_keys, invitations, ownership_transfers, rotations TO petty_api;
GRANT SELECT, INSERT, UPDATE ON users, user_keys, user_docs, drawers, drawer_documents, line_heads TO petty_api;
GRANT SELECT, INSERT, UPDATE, DELETE ON drawer_photos TO petty_api;
GRANT SELECT, INSERT ON entries TO petty_api;                       -- no UPDATE, no DELETE
GRANT SELECT ON drawers, drawer_documents, drawer_photos, entries, rotations TO petty_maint;
GRANT UPDATE (ciphertext, nonce, key_version) ON entries TO petty_maint;   -- rotation
GRANT UPDATE ON drawer_documents, drawer_photos, rotations TO petty_maint;

-- Down Migration
DROP TRIGGER entries_bump_last_write ON entries;
DROP TRIGGER entries_rotation_only ON entries;
DROP FUNCTION delete_drawer(uuid);
DROP FUNCTION delete_line(uuid, uuid);
DROP FUNCTION bump_last_write();
DROP FUNCTION entries_rotation_only();
DROP TABLE entries, line_heads, rotations, ownership_transfers, invitations, drawer_keys, drawer_members, drawer_photos, drawer_documents, drawers, user_docs, join_links, sessions, user_keys;
ALTER TABLE users DROP COLUMN vault, DROP COLUMN recovery_vault, DROP COLUMN deleted_at;
