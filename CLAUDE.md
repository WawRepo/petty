# Petty

A private record of what people keep and where: money in several currencies, counted things and
single items, in drawers that sit in places. It began as a ledger for physical cash. End-to-end
encrypted, shared per drawer with specific people. Household scale —
a handful of users, not a multi-tenant product.

## Read these first

- `docs/decisions.md` — every settled design decision (continues the Decisions log of the
  original spec). Settled means settled: disagree out loud, don't build around it.
- `docs/threat-model.md` — what Petty defends against and what it explicitly does not.
- [petty-app-spec.md](docs/history/petty-app-spec.md) — the original specification, **frozen as history** (2026-09-25). Useful for
  background and reasoning; where it disagrees with the two documents above, they win.
- [petty.html](docs/history/petty.html) — the working prototype. Reference for UI, visual design and
  interaction flows. Its *code* is not reused; it is a single-file vanilla-JS
  artifact and the real app is a rewrite.
- [petty-spec-review.md](docs/history/petty-spec-review.md) — the review that produced those decisions, with the
  reasoning behind each.

## Stack

Vite + React + React Router (static SPA) · thin backend API · Postgres ·
Argon2id + AES-256-GCM + ECDH P-256 · English and Polish from day one; German, Spanish
and French since PETTY-249 (every dictionary must pass `pnpm i18n:check`).

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
screen's layout or to a visible feature is reflected there in the same change**:
re-run the capture (`MARKETING=1 MARKETING_OUT=<dir> WEB_PORT=5174 npx
playwright test e2e/marketing.spec.ts` in `apps/web`, then convert the PNGs to
webp into `apps/web/public/landing/`), extend the capture's data when the
feature needs it, and update the feature cards, alt texts and FAQ in every dictionary
(`apps/web/src/i18n/`). A landing page that shows last month's app is a bug.

## Working style

- The Decisions log (`docs/decisions.md`) is settled. If you believe a decision is wrong, **say so**
  rather than quietly implementing something else.
- Use the reviewed primitives Petty settled on — WebCrypto (AES-256-GCM, ECDH P-256, ECDSA, HKDF) and
  hash-wasm's Argon2id (SPEC-ISSUES C1, security review SR-14) — and never hand-assemble crypto.
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
  data). Each change adds or changes an integration test that covers what it
  changed, or says in its pull request why none applies. Run it before the
  change is merged, and say the result in the pull request.
- **The ciphertext compatibility corpus is permanent.** Fixtures generated by
  each format version must remain decryptable by every future build, in CI.
- The `[decide]` items in [SPEC-ISSUES.md](docs/history/SPEC-ISSUES.md) are decided; the spec reflects them.
  [SPEC-ISSUES.md](docs/history/SPEC-ISSUES.md) stays as the reasoning record.
- Multi-user tests use **two Playwright browser contexts** with different users.
  Single-context tests cannot catch this app's concurrency bugs.
- Permission tests call the API **directly**, not through the UI. Hiding a button
  proves nothing about enforcement.
- The concurrency scenarios listed in the spec are required, not optional —
  particularly simultaneous Adjusts on one line.

## Releasing

A release is started by hand and never waits for CI (PETTY-254, `.github/workflows/release.yml`).

- **Start it from main:** Actions → *release* → Run workflow, or `gh workflow run release.yml --ref main`.
- **It refuses** while `ci.yml` runs on main, and when `ci.yml`'s latest run on main did not pass on
  main's newest commit. A refused run publishes nothing: let CI finish (or fix main), then start it again.
- **The version is counted, never chosen:** the highest `vX.Y.Z` tag plus one patch. To start a new
  minor or major, push a tag by hand (`git tag v1.6.0 && git push origin v1.6.0`). That tag releases
  nothing; the next release is `v1.6.1`.
- **The workflow makes the release commit** ("Release X.Y.Z": the version in every `package.json` and in
  `apps/mcp/mcpb/manifest.json`; `## [Unreleased]` in `CHANGELOG.md` becomes `## [X.Y.Z] — date`), tags
  it `vX.Y.Z`, builds and pushes the image, and publishes the GitHub Release with that section as notes.
  Then a second job lists the add-on in the MCP Registry (`mcp-registry.yml`). The release is already
  out at that point: if only that job fails, run `gh workflow run mcp-registry.yml --ref main -f tag=vX.Y.Z`.
- **Never bump a version or write a version heading by hand.** Each user-visible change adds its lines
  under `## [Unreleased]` in the same commit as the change. An empty section ships as "Maintenance only".
- **After a release, pull before you push:** main has the release commit on top. Deploying a release is
  the operator's step and lives outside this repository.
- **When Actions cannot run** (v1.5.1–v1.5.8 were made this way, while Actions were blocked on the then
  private repository), do the workflow's steps by hand, in its order: `node scripts/release.ts X.Y.Z
  <date> notes.md`; commit "Release X.Y.Z" and an annotated tag `vX.Y.Z`; build from `git archive
  vX.Y.Z`, each platform on a machine of that platform (`docker buildx build --platform linux/amd64`,
  then `linux/arm64`, both with `--provenance=true --sbom=true --build-arg PETTY_VERSION=vX.Y.Z`,
  pushed by digest); join them with `docker buildx imagetools create -t <image>:vX.Y.Z <amd64 digest>
  <arm64 digest>`; run the upgrade test (`make integration BASE=<previous image>`); push main and the
  tag together (`git push --atomic`); pack the add-on, the skill and the command line, write `SHA256SUMS`,
  and `gh release create` with the section as notes; move `latest`; list the add-on in the MCP Registry
  (`node scripts/mcp-server-json.ts vX.Y.Z petty.mcpb > server.json`, then `mcp-publisher login github`
  and `mcp-publisher publish server.json`). An image built this way has no CI provenance (no source
  revision).
