-- Up Migration
-- PETTY-216: which version of the operator's terms of service (LEGAL_DIR, PETTY-342) a person accepted by
-- creating the account, and when. The version is a hash of the terms files, so the operator can match it
-- to the text that was live. Null for accounts made before terms existed, or on an instance without terms.
ALTER TABLE users ADD COLUMN terms_version text, ADD COLUMN terms_accepted_at timestamptz;

-- Down Migration
ALTER TABLE users DROP COLUMN terms_accepted_at, DROP COLUMN terms_version;
