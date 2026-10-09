-- Up Migration
-- PETTY-241: "last seen" per user, in both sign-in modes. Under Clerk there are no sessions rows, so the
-- active-user gauges and the admin list's "last seen" read nothing. The request hooks touch this column
-- at most every 5 minutes per user (local sessions, Clerk tokens and access tokens alike).
ALTER TABLE users ADD COLUMN last_seen_at timestamptz;
UPDATE users u SET last_seen_at = s.seen FROM (SELECT user_id, max(last_seen_at) AS seen FROM sessions GROUP BY user_id) s WHERE s.user_id = u.id;
CREATE INDEX users_last_seen_idx ON users (last_seen_at) WHERE deleted_at IS NULL;

-- Down Migration
DROP INDEX users_last_seen_idx;
ALTER TABLE users DROP COLUMN last_seen_at;
