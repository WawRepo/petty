# Petty

A ledger for physical cash kept in several places, across multiple currencies.
End-to-end encrypted, shared per drawer with specific people. Household scale —
a handful of users, not a multi-tenant product.

## Read these first

- `docs/decisions.md` — every settled design decision (continues the Decisions log of the
  original spec). Settled means settled: disagree out loud, don't build around it.
- `docs/threat-model.md` — what Petty defends against and what it explicitly does not.
- `petty-app-spec.md` — the original specification, **frozen as history** (2026-09-25). Useful for
  background and reasoning; where it disagrees with the two documents above, they win.
- `petty.html` — the working prototype. Reference for UI, visual design and
  interaction flows. Its *code* is not reused; it is a single-file vanilla-JS
  artifact and the real app is a rewrite.
- `petty-spec-review.md` — the review that produced those decisions, with the
  reasoning behind each.

## Stack

Vite + React + React Router (static SPA) · thin backend API · Postgres ·
Argon2id + AES-256-GCM + ECDH P-256 · English and Polish from day one.

Next.js was considered and rejected: with E2EE the server can never render user
content, so its server half is inert.

## Non-negotiable rules

These come from the threat model. Violating any of them silently breaks the
product's core promise, and most cannot be fixed after data exists.

1. **Never write decrypted content to disk.** Plaintext lives in memory only.
   IndexedDB caches non-extractable `CryptoKey` handles, never raw key bytes and
   never decrypted drawer content.
2. **Never log plaintext.** Errors report a typed class (`WrongPassphrase`,
   `AuthTagMismatch`, `UnknownSchemaVersion`) plus IDs. Never content. Session
   replay tooling is forbidden.
3. **Every ciphertext binds its identity as AAD** —
   `record_type || record_id || drawer_id || line_id || author_id || key_version || schema_version`
   (`line_id` is empty for documents and photos; `author_id` is server-stamped).
   This is not retrofittable; a ciphertext must never be decryptable in a row it
   did not come from, under another line, or attributed to another author.
4. **Every encrypted row carries plaintext `key_version` and `schema_version`.**
   Without them, key rotation and format evolution are impossible.
5. **Amounts are integers in minor units.** The decimal exponent is stored on
   the line, never looked up from the currency code — the code is an editable
   label, and deriving the exponent from it would silently rescale history.
6. **Balances are folded from the entry log. Entries store no balance.** The
   fold starts at the latest Adjust and applies later entries in `seq` order.
   Tampering signals are the hash chain, the AAD, and a log shorter than the
   last pinned head — never a stored number.
7. **All writes go through the backend API.** Clients never write to the
   database directly. Read-only members hold the same decryption key as writers,
   so server-side enforcement is the only real permission boundary.
8. **Entries are append-only at the database level** — UPDATE and DELETE are
   revoked, not merely avoided in application code.
9. **No user-facing string is hardcoded.** Everything goes through the i18n
   dictionaries. Polish plural rules (1 / 2–4 / 5+) mean ICU MessageFormat, never
   a number concatenated to a noun.
10. **Clickable means `<button>`.** Never a `div` with an `onclick`. Icon-only
    controls need real accessible names. Reordering must work without a mouse.

## The index page follows the app

The landing page (`apps/web/src/screens/LandingScreen.tsx`, what a visitor sees
at `/`) shows real captures of the app and lists its features. **Any change to a
screen's layout or to a visible feature is reflected there in the same ticket**:
re-run the capture (`MARKETING=1 MARKETING_OUT=<dir> WEB_PORT=5174 npx
playwright test e2e/marketing.spec.ts` in `apps/web`, then convert the PNGs to
webp into `apps/web/public/landing/`), extend the capture's data when the
feature needs it, and update the feature cards, alt texts and FAQ in `en.json`
and `pl.json`. A landing page that shows last month's app is a bug.

## Working style

- The Decisions log (`docs/decisions.md`) is settled. If you believe a decision is wrong, **say so**
  rather than quietly implementing something else.
- Prefer boring, reviewed libraries (libsodium) over hand-assembled WebCrypto.
- If something cannot be tested meaningfully, say so rather than writing a test
  that passes vacuously.
- Report what you actually verified, not what you intended. "Tests pass" means
  you ran them.
- Encrypted data cannot be inspected in production. Anything that helps diagnose
  a problem locally is worth more here than in a normal app.

## Testing requirements

- **Every change revises the integration tests.** `tests/integration` runs the
  production image under `deploy/compose` over real HTTP (`make integration`;
  `make integration BASE=<older image>` also checks an upgrade keeps existing
  data). Each ticket adds or changes an integration test that covers what it
  changed, or says on the ticket why none applies. Run it before closing the
  ticket and put the result there.
- **The ciphertext compatibility corpus is permanent.** Fixtures generated by
  each format version must remain decryptable by every future build, in CI.
- The `[decide]` items in `SPEC-ISSUES.md` are decided; the spec reflects them.
  `SPEC-ISSUES.md` stays as the reasoning record.
- Multi-user tests use **two Playwright browser contexts** with different users.
  Single-context tests cannot catch this app's concurrency bugs.
- Permission tests call the API **directly**, not through the UI. Hiding a button
  proves nothing about enforcement.
- The concurrency scenarios listed in the spec are required, not optional —
  particularly simultaneous Adjusts on one line.
