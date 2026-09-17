-- Up Migration
-- Identity via Clerk (PETTY-88, docs/auth-clerk.md): a user provisioned after a Clerk sign-in
-- has a Clerk user id and no login password. Local-mode users keep both as before.
ALTER TABLE users ADD COLUMN clerk_user_id text UNIQUE;
ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL;

-- Down Migration
ALTER TABLE users ALTER COLUMN password_hash SET NOT NULL;
ALTER TABLE users DROP COLUMN clerk_user_id;
