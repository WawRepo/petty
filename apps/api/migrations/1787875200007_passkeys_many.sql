-- Up Migration
-- PETTY-102: passkey first. Several passkeys per account (one per device), each
-- with a label. Still public data or ciphertext only; the PRF output never
-- reaches the server. users.vault (the passphrase copy) becomes optional in
-- practice: an account may have passkeys + the recovery copy and no passphrase.
ALTER TABLE passkey_vaults DROP CONSTRAINT passkey_vaults_pkey;
ALTER TABLE passkey_vaults ADD COLUMN id uuid NOT NULL DEFAULT gen_random_uuid();
ALTER TABLE passkey_vaults ADD PRIMARY KEY (id);
ALTER TABLE passkey_vaults ADD COLUMN label text NOT NULL DEFAULT '';
ALTER TABLE passkey_vaults ADD COLUMN transports text[] NOT NULL DEFAULT '{}';
ALTER TABLE passkey_vaults ADD CONSTRAINT passkey_vaults_user_credential UNIQUE (user_id, credential_id);
CREATE INDEX passkey_vaults_user_idx ON passkey_vaults (user_id, created_at);

-- Down Migration
DROP INDEX passkey_vaults_user_idx;
ALTER TABLE passkey_vaults DROP CONSTRAINT passkey_vaults_user_credential;
ALTER TABLE passkey_vaults DROP COLUMN transports;
ALTER TABLE passkey_vaults DROP COLUMN label;
ALTER TABLE passkey_vaults DROP CONSTRAINT passkey_vaults_pkey;
ALTER TABLE passkey_vaults DROP COLUMN id;
DELETE FROM passkey_vaults a USING passkey_vaults b WHERE a.user_id = b.user_id AND a.created_at < b.created_at;
ALTER TABLE passkey_vaults ADD PRIMARY KEY (user_id);
