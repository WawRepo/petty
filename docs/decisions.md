# Decisions

**Maintained log of settled design decisions.** Continues the Decisions log of
[petty-app-spec.md](history/petty-app-spec.md) (frozen 2026-09-25 as history). A settled decision is not re-litigated during
implementation: if you believe one is wrong, open an issue and say why, rather than quietly building
something else. Superseded rows are marked, not deleted. The reasoning for the early rows is in
[SPEC-ISSUES.md](history/SPEC-ISSUES.md) and [petty-spec-review.md](history/petty-spec-review.md); the threat model they serve is [threat-model.md](threat-model.md).

## Settled with the specification (2026-08)

| Question | Decision |
|---|---|
| Key verification | Safety numbers, confirmed out of band, pinned on first use |
| Ledger integrity | AAD binding (incl. line and author), hash-linked entries as a tree + pinned head, ECDSA author signatures |
| Photo storage | Own encrypted row under the drawer key; downscaled, EXIF stripped |
| Invitations | Two-phase — join the app first, then be added; drawer key wrapped at invite time |
| Concurrency | Optimistic locking on the document; entries append freely |
| Offline | Short windows, PWA, encrypted outbox, reports differences on reconnect |
| Key rotation | Resumable and versioned; **executed by a member's client** (the server holds no keys and only tracks progress). *Corrects the spec table, which said "backend-executed" while its own Security section said the client does it.* |
| Authorship | Recorded on everything; shown as a small hover/tap icon |
| Threat model | Written, including what is explicitly *not* defended against — now [threat-model.md](threat-model.md) |
| Write enforcement | All writes via the backend API; never client-to-database |
| Money representation | Integers in minor units; exponent pinned to the line |
| Places | An ordered path of names on the drawer (`tags`); the tree per person in the user document, merged with drawer paths on read; renames/moves rewrite the writable drawers |
| Icons | A slug from a fixed Lucide set on drawers and lines; unknown slugs fall back |
| Line tags / not cash | In the document (shared): `tags` for filtering, `counted: false` keeps a line out of every total; the tag list is per person in the user document (`line_tags`), merged with drawer tags on read |
| Session lock | 24 hours, no idle timeout, manual "Lock now" |
| Deletion | Permanent, no trash, no undo — for entries (reversed, never erased) and deleted drawers. *Refined 2026-09-19, see "Drawer document history".* |
| Verification staleness | Any change of any kind marks it stale |
| Single items in verification | Included, as ticks defaulting to present |
| Account deletion | Forces a per-drawer choice: hand over or delete |
| Editing after creation | Names and currency code always; kind locks on first entry |
| Correcting mistakes | Reverse operation, linked to the entry it cancels |
| Read access | Sees everything except export |
| Negative balances | Warn, allow, flag until reconciled |
| Currency codes | Free text with ISO suggestions and formatting fallback |
| History loading | Paginated, always fetched back to the last Adjust |
| Accessibility | Keyboard and labelling built in; formal audits deferred |
| Totals and search | Totals in scope; search deferred |
| Auth | Backend-owned email + password; invite-only signup. *Extended: see "Identity provider" and "Open sign-up".* |
| Concurrent Adjust | Conditional insert on `expected_head_seq`; first write wins |
| Reverse limits | Not past the latest Adjust; reverse-once enforced by a plaintext UNIQUE |
| Stored balances | None; fold only |
| Staleness clock | Server `last_write_at` vs. verification server time |
| Signing key | Separate ECDSA P-256 keypair; both keys in the safety number |
| Private-key wrap | AES-256-GCM with public keys in the AAD |

## Decided since

- **Passkey unlock (Phase 14, 2026-08-29)**, then **passkey first (PETTY-102, 2026-09-16)** — a vault
  is created with a passkey as its first door (a passphrase on request or later); one passkey vault per
  device (`passkey_vaults`); the recovery code stays mandatory; adding/removing a passkey takes the
  custody proof; the last passkey cannot go while there is no passphrase (`LastDoor`). The server never
  verifies assertions — a passkey is a key holder, not a login. A plaintext storage mode was rejected:
  it breaks the product's one promise.
- **Custody proofs (security review SR-2, 2026-09-08; extended PETTY-201).** Replacing the vault,
  deleting the account, deleting a drawer and creating an access token require a server-issued
  challenge signed with the account key. Replaced vault blobs are kept 30 days in `vault_history`; an
  admin can restore one; the owner is emailed on a password reset and a vault change. Reason: the
  login password is resettable by email; the vault key is not.
- **Identity provider (PETTY-88).** `AUTH_PROVIDER=local` (Petty's own login, the self-host default)
  or `clerk` (sign-up, sign-in, sessions, reset via Clerk). In both, the vault, passkey unlock and
  custody proofs stay Petty's. See [auth-clerk.md](auth-clerk.md).
- **Clerk code is bundled, not fetched (PETTY-185, 2026-09-19).** clerk-js ships inside the app at a
  pinned version so the page holding the vault keys runs only code that was built and reviewed; the
  CSP lists no Clerk script origin.
- **Admins (2026-09).** An admin flag grants account management (list, block/unblock, revoke sessions,
  restore a vault blob, grant admin) and no content access. Granted from the container with
  `make-admin`.
- **Access tokens (PETTY-164/169/181/184).** A token carries a sealed key bundle opened only on the
  tool's machine, its own delegated signing key, and a scope (all drawers or listed ones, read or
  write). The server keeps an allow-list; every route not on it is refused to tokens. Revocation is
  immediate. Diagram in [README.md](README.md).
- **The command line and device login (PETTY-274, 2026-09-28).** `petty` is one file (`petty.mjs`,
  Node 20+) on `@petty/agent`, shipped with each release and served at `/downloads/petty.mjs`; it
  also runs the MCP server (`petty mcp`). It signs in like `gh auth login` (RFC 8628): the web app's
  `/device` page makes an ordinary access token and seals it to the command line's one-time key, and
  the server only relays the sealed blob. The code is derived from that key (12 of 20 consonants), so
  the page and the command line both detect a swapped key. Only the login is stored
  (`~/.petty/hosts.json`, 600); Tab completion decrypts names per key press, never cached on disk.
- **Drawer document history (PETTY-194, 2026-09-19).** Names, items, tags and places before each
  change are kept for 30 days and the drawer's owner can restore an earlier version. Entries and
  balances are unaffected. Refines "Deletion" above for the document only.
- **Open sign-up (PETTY-215).** Local mode only: `OPEN_SIGNUP=true` lets anyone create an account
  without a join link (a public self-hosted instance). Default stays invite-only; the first account of
  an installation is minted with the `join-link` script.
- **Public hosted instance (Route B, 2026-09-21).** Petty also runs as a public hosted service. The
  household-scale design is unchanged: each account is its own household. Large multi-tenant scale
  remains a non-goal. Operator specifics (hosting, secrets, DNS) live outside this repository; the
  image takes everything from its environment.
- **Backups are the operator's (2026-09-24).** The app ships no backup job and promises no retention.
  The privacy page and docs describe what a backup would contain and leave schedule and retention to
  the operator; [deploy.md](deploy.md) gives a dump/restore procedure and says to test a restore.
- **Telemetry (PETTY-92).** Metrics, logs and traces never carry content. All three can push over
  OTLP to one endpoint (`OTEL_PUSH`), alongside the Prometheus scrape and stdout logs;
  `DEPLOYMENT_ENV` tags every signal so instances don't merge. See [monitoring.md](monitoring.md).
- **Version stamped at build (PETTY-218).** The image knows its release (`PETTY_VERSION` from the git
  tag); `/api/config`, Settings and the landing footer show it.
- **Releases (2026-09-23/24; PETTY-254).** Multi-architecture images built by CI with provenance and an
  SBOM, pinned by digest. While CI could not run (v1.5.1–v1.5.6), releases were built by hand with the
  same steps (CLAUDE.md, "Releasing"); their provenance names no source revision. A release is started by hand from main and never waits for CI: it is refused
  while `ci.yml` runs on main, or when its latest run there did not pass on main's newest commit. The
  version is the highest `vX.Y.Z` tag plus one patch (a tag pushed by hand starts a new minor or major);
  the workflow makes the release commit, the tag and the GitHub Release. Runtime is Node 24 LTS.
- **Contributions (2026-09-25).** AGPL inbound = outbound with a DCO `Signed-off-by` per commit; no CLA.
- **History (2026-09-25).** Deleted hosting files and private repository names in git history are
  accepted as public (no credentials); no history rewrite.
- **Languages (PETTY-249).** English, Polish, German, Spanish and French: the app, the Clerk sign-in
  forms and every email. English is built in; the others load on demand. A first visit follows the
  browser's language; a choice is kept on the device and, signed in, on the account (so emails follow
  it). A join link goes out in the inviter's language. Informal address in German and Spanish (du, tú),
  formal in French (vous). `i18n:check` fails on a missing key, a broken ICU message, a changed
  placeholder or a plural category the language does not have.
- **Storage limits (PETTY-243).** The server counts only ciphertext bytes; it never needs to read
  anything to enforce a limit. A photo is at most 300 KB before sealing, enforced by the API as well
  as the client; an entry at most 16 KiB sealed. An optional per-person quota (`STORAGE_QUOTA_MB`,
  off by default) covers photos, documents with their 30-day history and entries in the drawers a
  person owns: a member's writes to a shared drawer count against its owner, who is the one able to
  free space. Writes that free space (a smaller photo, removing a photo, deleting a line or drawer)
  always pass. The check is soft: writes racing at the limit may overshoot by one record.
- **The app's look (PETTY-248/250, 2026-09-27).** A line's colour is its kind: money green, counted
  things blue, single items amber (`--k-money/--k-things/--k-notes`), on the landing page and in the
  app alike. Pictures — the landing examples, a drawer's header, the home beside the total — are
  bubbles round a middle. In the app every bubble is a shortcut for the list below it, so it is hidden
  from the accessibility tree and the tab order; the list stays the keyboard and screen-reader path. A
  tapped bubble grows into the next screen's picture through the View Transitions API where the
  browser has it. Nothing moves on its own in the app, and reduced motion turns every movement off.
  The landing demo is the one thing that plays by itself (with a Pause button, WCAG 2.2.2); under
  reduced motion it still plays, with cross-fades only — nothing slides, pops or floats (PETTY-251).
  A drawer may take a colour (PETTY-252) from a fixed palette of eight muted shades — never the
  danger red or the "check" amber — stored as a slug in its encrypted document; it replaces the
  accent wherever the drawer is drawn. Lines have no colour of their own: theirs is their kind.
- **The Home picture with places (PETTY-257, 2026-09-28).** Once there are places, the Home picture is
  the place tree, under the total at the card's full width: the place in view in the middle, its places
  and the drawers kept right in it on the first ring, what is in each place in a fan round it. A place's
  bubble picks it exactly as its chip does, and the picture goes one level down; the levels above wait as
  small bubbles in a corner. A level that holds one place and nothing else shows what is in that place
  (a house whose rooms all sit in "Home"). Every place and drawer keeps one bubble, and one out of view
  folds into its nearest bubble in view, so each change is one glide. Without places the picture stays the home beside
  the total. "Show the picture" (on by default) is in the encrypted user document, like the other Home
  settings. The picked place outlives the screen in memory only — never in the URL or storage, since
  place names are content — so Back from a drawer lands on its level (PETTY-269); a drawer's screen
  shows the trail to its place, and Back plays the morph the other way. The app's pictures (Home, with
  or without places, and a drawer's) animate only transform and opacity (PETTY-269, PETTY-273), so a
  move never lays the page out again frame by frame: a bubble glides in a straight line, and a spoke is
  drawn anew where it belongs and fades in. The landing's pictures still turn round their ring.
- **Theme (PETTY-259, 2026-09-28).** Settings offers the device's own theme, light or dark. The choice
  is kept on the device, not on the account: a phone and a laptop may want different ones. A forced
  theme is a `data-theme` on `<html>` that picks the palette in `tokens.css`, so every colour still
  comes from the tokens.

## Non-goals

- No budget categories, no bank sync, no automatic exchange-rate conversion.
- No server-side plaintext access to drawer content, by design — support and debugging work from error
  classes and ids, never content.
- Not built for large multi-tenant scale. A public instance serves many households, each at household
  scale; several decisions above would need revisiting beyond that.
