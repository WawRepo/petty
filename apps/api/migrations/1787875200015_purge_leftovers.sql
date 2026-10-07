-- Up Migration
-- PETTY-341 (GDPR, storage limitation). A password reset lives an hour, and a join link's email (a person
-- who may never sign up) is needed only until the link is used or ends. Maintenance now deletes expired
-- resets and expired unused links, and a link forgets its email when it is used; for the first it needs
-- DELETE on password_resets. The emails already left behind go now.
GRANT DELETE ON password_resets TO petty_api;
UPDATE join_links SET email = NULL WHERE email IS NOT NULL AND used_at IS NOT NULL;
DELETE FROM join_links WHERE used_at IS NULL AND expires_at < now();
DELETE FROM password_resets WHERE expires_at < now();

-- Down Migration
REVOKE DELETE ON password_resets FROM petty_api;
