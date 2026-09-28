-- Up Migration
-- PETTY-274: device login. `petty auth login` asks for a token; the person allows it on /device in the
-- web app, which makes an ordinary access token there and seals it to the tool's one-time key. This
-- table only relays: the tool's public key, the code derived from it, what was asked, and the sealed
-- token, which the server cannot open. The tool polls with a secret whose hash is `device_hash`.
-- A row lives 15 minutes and is deleted when the tool picks up its answer.
CREATE TABLE device_requests (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  device_hash   bytea NOT NULL UNIQUE,
  user_code     text NOT NULL UNIQUE,
  cli_pub       text NOT NULL,
  client_name   text NOT NULL,
  role          text NOT NULL CHECK (role IN ('read', 'write')),
  -- how long the token asked for lasts; NULL = until revoked
  expires_days  int NULL CHECK (expires_days IN (30, 90, 365)),
  -- the address the request came from, shown on the page so a person can tell it is theirs
  ip            text NULL,
  state         text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'approved', 'denied')),
  -- who allowed or denied it
  user_id       uuid NULL REFERENCES users(id) ON DELETE CASCADE,
  sealed_token  jsonb NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  last_poll_at  timestamptz NULL
);
CREATE INDEX device_requests_expires_idx ON device_requests (expires_at);

GRANT SELECT, INSERT, UPDATE, DELETE ON device_requests TO petty_api;

-- Down Migration
DROP INDEX device_requests_expires_idx;
DROP TABLE device_requests;
