# Identity via Clerk, vault stays ours (PETTY-88)

## The split

| | Who does it | Where it lives |
|---|---|---|
| **Identity**: sign up, sign in, sessions, password reset, bot protection, invitations | Clerk | Clerk; the API only *verifies* Clerk session tokens |
| **Vault**: the keypairs wrapped by the passphrase (Argon2id), the recovery code, passkey unlock (PRF), custody proofs | Petty, unchanged | `users.vault`, `recovery_vault`, `passkey_vaults`, `user_keys` |

A valid Clerk session with no vault (or a wrong passphrase) shows the locked screen, never
data: the vault is opened on the device and the server never sees a key.

## One switch, two modes

`AUTH_PROVIDER=local` (default) keeps every existing route and the cookie session: the Pi
cluster, `make demo` and the test suite run as before. `AUTH_PROVIDER=clerk` turns on:

- **Requests** carry `Authorization: Bearer <Clerk session token>`; the session plugin
  verifies it (`@clerk/backend` `verifyToken`, offline with `CLERK_JWT_KEY`, else JWKS via
  `CLERK_SECRET_KEY`) and maps `sub` → `users.clerk_user_id`. Blocked or deleted users are
  refused the same way as before. No cookie, no `sessions` rows.
- **Provisioning** — `POST /auth/provision`: after the first Clerk sign-in the app finds no
  vault (`GET /me` → 404 `NoVault`) and shows the vault setup screen (same keys, passphrase
  and recovery code flow as the old join screen); the server takes the email and name from
  Clerk (backend API) and creates the `users` row with `clerk_user_id`, no password.
- **Off**: `/auth/signup`, `/auth/login`, `/auth/forgot`, `/auth/reset`, `/auth/logout`,
  `/join-links*` answer 404 `NotAvailable`. Invitations are Clerk's (Restricted sign-up mode).
- **Relink by verified email (PETTY-104)**: when a bearer token's `sub` matches no
  users row, the API asks Clerk for the identity's primary email once; if Clerk
  verified it, the live row with that email (an earlier Clerk identity that was
  replaced, e.g. GitHub sign-up after an email account, or a local-mode account
  from before the switch) is relinked to this `sub`. The user meets their own
  vault on the unlock screen, not the setup screen. Unverified emails never link.
- **Password-gated vault routes** (`PUT /me/vault`, `POST /me/passkeys`, `DELETE /me/passkeys/:id`,
  `POST /me/delete`): the login password check is skipped — there is none — and the
  **custody proof** (a signature with the account's key) stays the gate, which is the
  stronger of the two anyway. Account deletion also deletes the Clerk user.
- **Admin**: block/unblock keep working (`blocked_at` is checked on every request);
  "revoke sessions" revokes the user's Clerk sessions through the backend API.
- **`GET /config`** (public) tells the web app the mode and the publishable key, so one
  image serves both modes.

## Browser side

- `@clerk/clerk-react`; clerk-js and its UI chunks load from the instance's frontend API
  origin (`CLERK_FRONTEND_API`), so `script-src` and `connect-src` add that origin in clerk
  mode. Clerk's components inject styles (`style-src 'unsafe-inline'`, `worker-src 'self' blob:`), the bot check loads
  Cloudflare Turnstile (`script-src`/`frame-src` `https://challenges.cloudflare.com`),
  `img-src` adds `https://img.clerk.com`, and Trusted Types enforcement is off. These are the
  relaxations, all listed in `lib/headers.ts`; local mode keeps the strict policy.
- Sign in / sign up / reset are Clerk's components at `/login` and `/join`.
- The token provider is set once Clerk reports a session; every API call adds the header.
- Sign out: Clerk `signOut()` plus the same IndexedDB wipe as before.
- Offline: the app keeps the cached `Me` and the unlocked key handles as today; Clerk
  refreshes the token when the network is back.

## Where the keys go

The root `.env` (see `.env.example`): `AUTH_PROVIDER`, `CLERK_SECRET_KEY`,
`CLERK_PUBLISHABLE_KEY`, `CLERK_FRONTEND_API`, optional `CLERK_JWT_KEY`. The web app needs no
key file — the publishable key travels through `GET /config`.

## Setting up a Clerk application

One Clerk application has exactly one production instance, and a production instance is
bound to one domain. Use one application per deployment domain.

Recommended settings: organizations off, `sign_up_mode: restricted` (people come in by
invitation) or public if anyone may sign up, device trust on. Social sign-in (for example
GitHub) works with Clerk's shared credentials on a development instance; production needs
your own OAuth app.

Taking an application to production:

1. `clerk deploy` and choose your domain. Clerk prints the DNS records (frontend API,
   accounts, email).
2. Add those records at your DNS provider; `clerk deploy status` until the domain is verified.
3. Create your own OAuth apps for social sign-in and enter their credentials in Clerk.
4. `clerk env pull` for the `pk_live_` / `sk_live_` keys. Give them to the server with
   `AUTH_PROVIDER=clerk` and `CLERK_FRONTEND_API=https://clerk.<your domain>`. Keep the
   keys out of the repository.
5. Existing local-mode accounts relink themselves to their Clerk identity on first
   sign-in by verified email (PETTY-104).

## Tests

- Local mode: the whole suite, unchanged.
- Clerk mode, API: `CLERK_JWT_KEY` set to a test RSA public key; tests mint tokens with
  `jose` — no network. Covers: bearer accepted, unknown `sub` → 404 `NoVault`, provision,
  local routes 404, custody-proof-only vault replace, blocked user refused.
- Clerk mode, browser: gated by `CLERK_E2E=1` with Clerk test-mode addresses
  (`+clerk_test`, code `424242`); not part of CI until the Clerk app exists.

## Decision record

Spec Decisions log: "Identity provider — Clerk in the public deployment; the vault and its
custody proofs unchanged; `AUTH_PROVIDER=local` keeps the self-hosted mode."
