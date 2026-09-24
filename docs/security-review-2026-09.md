# Security review, September 2026

This is the public version of an internal application security review of Petty. It was done on
2026-09-08 against the code of that day, and the fixes landed the same day. Details about the
reviewer's own deployment (addresses, storage paths, cluster settings) are removed. Findings,
causes and fixes are unchanged.

> **Scope note (added 2026-09-24).** This review looked at the reviewer's own deployment of that
> day — a Kubernetes cluster with its own manifests, which are not part of this repository — as well
> as the application code. Statements about pods, manifests, network policies or cluster settings are
> observations of that deployment, not guarantees of the shipped image or of `deploy/compose`. The
> application-level findings (SR-1 … SR-14) and their fixes are in this repository. A second internal
> review on 2026-09-19 (13 findings, cited in CHANGELOG 1.2.0 → Security) is not published in full.

## Scope and method

- **Static review:**
  - the spec's Security section and Decisions log
  - every file under `apps/api/src`, `apps/api/migrations`, `packages/crypto/src` and `packages/protocol/src`
  - `packages/ledger/src/chain.ts`
  - the web app's `lib/` (session, pins, custody, passkey, credentials, idb, outbox, drawers, sync, photo, api)
  - the Vite config, the entry points, the Dockerfile, the compose files, the CI workflow, the lockfile
  - the reference Kubernetes manifests of that time
- **Checks run, all passed:**
  - `pnpm typecheck` and `pnpm lint`
  - the crypto, ledger and protocol suites, including the ciphertext corpus and the known-answer tests
  - the API suite against a local Postgres
  - `pnpm audit --prod`
- **Proof of SR-1:** one throwaway script against the in-memory app.
- **Not done:** requests against a live deployment. Statements about the observability stack are
  marked PLAUSIBLE.

## What was already right

- **AAD:** it binds the full row identity, length-prefixed and domain-separated
  (`packages/crypto/src/identity.ts`). Opening an entry also checks the payload's own ids against
  the row, so a server cannot re-attribute an entry.
- **Nonces and padding:** nonces are always fresh, and production code cannot choose them.
  Plaintext is padded to size buckets.
- **Vault:**
  - The KDF is Argon2id with 64 MiB and t=3. Stored KDF parameters are bounds-checked.
  - The wrap AAD binds both public keys.
  - The recovery code is 150 bits from `getRandomValues` with an unbiased mapping.
- **Drawer key wrap:** static ECDH, then HKDF bound to the drawer and key version, then AES-KW.
  The recipient unwraps only with the pinned sender key. Signatures and chain hashes exclude the
  signature itself, to avoid ECDSA malleability.
- **Key storage:** private keys live in IndexedDB only as non-extractable `CryptoKey` handles.
  The offline outbox stores sealed rows. The service worker never caches `/api`.
- **CSP:** it uses Trusted Types and allows no inline script or style, with `connect-src 'self'`
  and `frame-ancestors 'none'`. There is no XSS sink in the web app.
- **Permissions:** the server enforces them on every drawer route, and non-members get 404. Tests
  exercise this through the API, not the UI.
- **Append-only entries:** the database enforces it. The request role has SELECT and INSERT only.
  The maintenance role may update three columns, and a trigger refuses anything else. Deletions go
  through SECURITY DEFINER functions.
- **Sessions:** the token is 32 random bytes, stored hashed, `HttpOnly`, `SameSite=Lax` and
  `Secure` in production. Blocked or deleted users fail the lookup. A password reset or a block
  revokes every session.
- **SQL and login:** all SQL is parameterised. Login answers the same for a wrong password and a
  blocked account.
- **Container:** it runs as non-root with a read-only root filesystem, no capabilities and the
  `RuntimeDefault` seccomp profile.
- **Tracing and metrics:** tracing redacts token routes and never records bound values, and a
  test proves it. Metric labels are route templates and fixed enums.

## Findings and their status

| # | Finding | Severity | Status |
|---|---|---|---|
| SR-1 | Join and reset tokens reached the request log through the SPA fallback | High | **Fixed** |
| SR-2 | The login password alone could replace a user's vault and delete their drawers, and email could reset that password | High | **Fixed** |
| SR-3 | A server could silently reset a user's key pins | Medium | **Fixed** |
| SR-4 | Database dumps held emails, password hashes and wrapped vaults unencrypted | Medium | **Fixed** |
| SR-5 | Observability stores held per-user activity | Low | **Mitigated** |
| SR-6 | The proxy was trusted for every hop, and no network policy existed | Low | **Fixed** |
| SR-7 | The login limiter leaked memory, allowed cheap lockouts and revealed unknown emails by timing | Low | **Fixed** |
| SR-8 | Sign-out left ciphertext and member metadata in IndexedDB | Low | **Fixed** |
| SR-9 | Tokens were in the URL path, and invite mail was unlimited | Low | **Fixed** |
| SR-10 | SMTP was plaintext by construction | Low | **Fixed** |
| SR-11 | Supply chain and container hygiene | Low | **Mostly fixed** |
| SR-12 | Small client-side custody notes | Info | **Fixed** |
| SR-13 | Session and cache hygiene | Info | **Fixed** |
| SR-14 | Accepted risks worth writing down | Info | **Fixed where it was code** |

### SR-1. Tokens in the request log

- **Cause:** the per-request log line recorded the URL, and the redaction only applied to routes
  whose template contained `:token`. The SPA fallback has no template, so `/join/<token>` and
  `/reset/<token>` were logged verbatim. The 500 handler logged the raw URL too.
- **Fix:** SPA paths are logged by their first segment only (`/join/…`), and the error handler
  uses the same redaction. `apps/api/test/metrics.test.ts` proves it.

### SR-2. The login password alone could destroy keys

- **Cause:** `PUT /me/vault` and `POST /me/delete` checked only the session and the login
  password, and `POST /auth/forgot` can reset that password by email. Someone who controls a
  user's mailbox could reset the password, overwrite both vaults and delete sole-owner drawers.
- **Fix:**
  - Both endpoints now require a custody proof: the server issues a challenge
    (`POST /me/custody-challenge`), and the client signs it with the user's ECDSA private key.
  - Replaced vaults are kept for 30 days (`vault_history`), and an admin can restore one.
  - Users get an email when their password is reset or their vault is replaced.

### SR-3. Silent pin reset

- **Cause:** pins lived only in the server-side user document. A missing document was treated as
  "no pins yet", so a server that dropped or rolled back the document turned confirmed pins back
  into first sight.
- **Fix:** the client remembers the document version in IndexedDB. A 404 or a lower version
  shows a warning, stops first-sight pinning and blocks sharing until the user acknowledges it.
  A two-browser Playwright test deletes the row in SQL and checks the warning.

### SR-4. Unencrypted dumps

- **Cause:** the nightly `pg_dump` was written as-is to network storage and kept for 30 days.
- **Fix:** the backup image (`deploy/backup`) pipes every dump through `age` to a public key. The
  private key stays off the server. A manual run was decrypted to a valid archive. The privacy
  page says what a dump contains.

### SR-5. Per-user activity in observability stores

- **Cause:** request logs carried the client IP and the user id, and traces carry the user id and
  the SQL text. Both were sent to stores with their own access rules.
- **Fix:** the IP was dropped from the request line. `docs/monitoring.md` says what the signals
  contain and how to protect them.
- **Not fixed here:** authentication on an operator's log and trace stores. That is up to each
  deployment.

### SR-6. Proxy trust and network isolation

- **Cause:** any pod in the cluster could reach the API with a forged `X-Forwarded-For` and get
  around the per-IP login limit. It could also reach Postgres and the metrics port.
- **Fix:** in the reference Kubernetes deployment, network policies now allow the API port only from the ingress controller and the
  metrics port only from the scraper. Postgres accepts only the API and the backup job.
  `TRUST_PROXY=true` is kept, because only the ingress can connect. This was checked from a pod
  in another namespace: all three connections were blocked.

### SR-7. Login limiter details

- **Cause:**
  - The attempts map was never pruned.
  - Ten wrong passwords locked any email for 15 minutes.
  - An unknown email returned before Argon2id ran, so its timing differed.
- **Fix:** expired keys are pruned, only failures count per email, and unknown emails get a dummy
  Argon2id verify.

### SR-8. IndexedDB after sign-out

- **Cause:** sign-out left the cached bootstrap (member names, emails and public keys) and the
  outbox in IndexedDB.
- **Fix:** sign-out wipes everything except the chain heads, which are the tamper-detection pins.
  The status turns anonymous first, and data loading refuses to run unless the vault is unlocked.
  A Playwright test checks the store after sign-out.

### SR-9. Tokens in the path, unlimited invites

- **Fix:** links now carry the token in the fragment (`/join#token`, `/reset#token`); the path
  form is still accepted. `POST /join-links` is limited to 5 per user per hour.

### SR-10. Plaintext SMTP

- **Fix:** `requireTLS` is on for every mail host except a local development relay. Credentials
  are optional.

### SR-11. Supply chain and container hygiene

- **Fixed:**
  - Base images are pinned by digest, and GitHub Actions by commit.
  - The image contains no tests or seed scripts.
  - The API process no longer receives the database owner password.
  - In the reference deployment, Postgres runs with a read-only root filesystem, and the image pull
    token is scoped to `read:packages`.
- **Not done:** compiling the API with `tsc`. The image still runs TypeScript through `tsx`, and
  the Dockerfile explains why.

### SR-12. Custody notes

- **Fix:** unlock refuses a vault that is not a passphrase vault. The privacy page says that the
  browser's password manager may store the vault passphrase and may sync it to a cloud account.

### SR-13. Session and cache hygiene

- **Fix:**
  - The session cookie is `__Host-` prefixed in production.
  - API responses carry `Cache-Control: no-store`.
  - Expired sessions are purged every hour.

### SR-14. Accepted risks

- **Destructive writers:** a member with write access can overwrite older entries' ciphertext
  during a key rotation. The signatures then fail, so the damage is visible, but the content is
  gone. The privacy page now says that a writer can damage history.
- **Fixed where it was code:**
  - A racing duplicate entry id is answered as a replay instead of a 500.
  - Signup checks the recovery vault's ECDSA key.
- **Crypto library:** Petty uses `hash-wasm` plus WebCrypto instead of libsodium. The reasoning is
  in `SPEC-ISSUES.md` (C1).

## Checked, no issue

- **CSRF:** `SameSite=Lax` plus a JSON-only guard on mutations. Form content types get 415, and
  there is no CORS plugin.
- **Errors:** error responses never include stack traces or content, and error context holds only
  ids and codes.
- **Uploads:** the request body limit is 2 MiB, and base64 fields are regex-validated. Photos are
  re-encoded in the browser to at most 1000 px and 300 KB.
- **Static files:** only `GET` outside `/api/` serves `index.html`, and path traversal is refused.
- **Admin routes:** every route requires an admin, targeting yourself is refused, and no route
  returns a vault or a key wrap to an admin.
- **Passkeys:** user verification is required, and the PRF salt is random per setup. The PRF
  output is zeroed after use, and there is no fallback without PRF.
- **Wrap sender id:** the server stamps it and overrides the client's value.
- **User-document key:** ECDH of the private key with its own public key, then HKDF with a fixed
  salt and the user id. It is deterministic, derivable only from the private key, and
  domain-separated from drawer wraps.
- **Metrics:** labels are bounded, the usage SQL returns aggregate counts only, and the metrics
  port is never routed publicly.
- **Trusted Types:** the policy allows only `createScriptURL` for `/sw.js`.
- **CI:** the ciphertext corpus and the known-answer tests run on every push.

## Reporting

See `SECURITY.md` for how to report a vulnerability privately.
