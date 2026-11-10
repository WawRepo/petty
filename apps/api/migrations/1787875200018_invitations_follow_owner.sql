-- Up Migration
-- PETTY-446: only a drawer's owner invites, and a pending invitation now ends when the drawer changes
-- hands. Pending invitations left by a former owner end here, once, so the owner of today can invite
-- the same person again.
UPDATE invitations i SET state = 'revoked', resolved_at = now()
  FROM drawers d
 WHERE d.id = i.drawer_id AND i.state = 'pending' AND i.inviter_id <> d.owner_id;

-- Down Migration
-- Nothing to undo: an ended invitation stays ended.
