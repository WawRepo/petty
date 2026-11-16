-- Up Migration
-- PETTY-349 (GDPR, storage limitation). Deleting an account leaves a tombstone: the users row (id, locale,
-- dates; no email, no name) and the account's public keys, so the records other people keep still show
-- "Deleted user" and still verify. It stayed for good. purge_tombstones() deletes a tombstone, its keys and
-- the rows that are only about it, once no record that someone else keeps needs it.
--
-- What needs a deleted person, so the tombstone stays:
--   * a record that names them as its author: an entry, a drawer document or photo, a replaced document
--     (drawer_document_history, also as the one who replaced it). Readers check its signature and its
--     additional data against the author's published keys (GET /users/:id/keys, /users/:id/delegations).
--   * a drawer key they wrapped for someone (a rotation they ran, or an invitation that was accepted):
--     the wrap's sender_id. A reader who never confirmed them opens it with their published key.
--   * anything account deletion ends, should one be left: an owned drawer, a membership, a key of their
--     own, an ownership transfer, a pending invitation.
-- The server sees every one of these: readers look keys up only by an entry's or document's author_id
-- and a wrap's sender_id, which are plain columns and plain JSON. Ids inside ciphertext (pins in a user
-- document) are never looked up on the server. Wraps given to access tokens are not counted: a tool opens
-- them with the owner key sealed in its token, never by sender, and the owner is a live account.
--
-- What goes with the tombstone, as nothing reads it: answered invitations (a pending one keeps it),
-- rotations it started, join links it used; and, by their foreign keys, its revoked tokens with their
-- delegations (only needed for its entries, of which there are none), and the creator of join links.
--
-- One tombstone at a time, its row locked first. A reference made after the check fails the foreign key
-- check of the delete, which then undoes only that tombstone: it stays for a later run. Nothing makes a
-- new reference to a deleted account in the first place (a new wrap's sender and a new record's author
-- are the signed-in person). Maintenance runs as petty_api; this function owns the deletes, so that role
-- gets no DELETE on users or user_keys, and it can never delete an account that is not deleted.
CREATE FUNCTION purge_tombstones() RETURNS integer
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

REVOKE ALL ON FUNCTION purge_tombstones() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION purge_tombstones() TO petty_api;

-- Down Migration
DROP FUNCTION purge_tombstones();
