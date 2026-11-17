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
| Totals and search | Totals in scope; search deferred. *Superseded (PETTY-47): Home searches item names, texts, tags and units, on the device only (`apps/web/src/lib/search.ts`).* |
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
  device (`passkey_vaults`), at most 20 per account (`MAX_PASSKEYS`, 409 `PasskeyLimit`, PETTY-442);
  the recovery code stays mandatory; adding/removing a passkey takes the custody proof; the last
  passkey cannot go while there is no passphrase (`LastDoor`). The server never verifies assertions —
  a passkey is a key holder, not a login. A plaintext storage mode was rejected:
  it breaks the product's one promise.
- **Custody proofs (security review SR-2, 2026-09-08; extended PETTY-200/201, PETTY-440/441, PETTY-513).**
  Replacing the vault or its recovery-code copy, adding or removing a passkey, deleting the account,
  deleting a drawer, deleting a line (`POST /drawers/:id/lines/:lineId/delete`), creating an access
  token, publishing a new drawer key (`POST /drawers/:id/rotation`) and every re-encryption batch
  after it (`PUT /drawers/:id/rotation/batch`), and since PETTY-513 every write of a drawer's document,
  its photo (replace and remove) and the user document require a server-issued challenge signed with the
  account key. PETTY-513 chose a proof per write over a proof bound to the session: a stolen session of
  an unlocked browser would pass a session-bound check, while a proof per write needs the key itself; it
  costs one small request before each of these writes and needs no new table or route. An access token
  writes a document without a proof (a proof made the token; its writes are signed with its own key). `POST /me/custody-challenge` gives one per person: 32 random bytes, five minutes, one
  use (`apps/api/src/lib/custody.ts`). Any write member's app may finish a rotation another began,
  with its own proof for each step. Replaced vault blobs are kept 30 days in `vault_history`; an
  admin can restore one; the owner is emailed on a password reset and a vault change. Reason: the
  login password is resettable by email; the vault key is not.
- **Identity provider (PETTY-88).** `AUTH_PROVIDER=local` (Petty's own login, the self-host default)
  or `clerk` (sign-up, sign-in, sessions, reset via Clerk). In both, the vault, passkey unlock and
  custody proofs stay Petty's. See [auth-clerk.md](auth-clerk.md).
- **Clerk code is bundled, not fetched (PETTY-185, 2026-09-19).** clerk-js ships inside the app at a
  pinned version so the page holding the vault keys runs only code that was built and reviewed; the
  CSP lists no Clerk script origin. Since Clerk 6 (PETTY-306) its UI package, `@clerk/ui`, is bundled
  the same way.
- **Admins (2026-09).** An admin flag grants account management (list, block/unblock, revoke sessions,
  restore a vault blob, grant admin) and no content access. Granted from the container with
  `make-admin`.
- **Access tokens (PETTY-164/169/181/184).** A token carries a sealed key bundle opened only on the
  tool's machine, its own delegated signing key, and a scope (all drawers or listed ones, read or
  write). The server keeps an allow-list (`apps/api/src/lib/tokens.ts`); every route not on it is
  refused to tokens. Revocation is immediate. Diagram in [README.md](README.md).
  *Since PETTY-397 (2026-10-28) the bundle also carries the owner's ECDH public key, and a tool opens a
  drawer key that arrives later only if that key wrapped it. Since PETTY-452 (2026-11-10) the owner
  picks the drawers (all, later ones included, or the ticked ones, at most 200), nothing is
  preselected, and every new token opens the vault again. Since PETTY-442 an account holds at most 50
  live tokens (`MAX_ACCESS_TOKENS`, 409 `TokenLimit`); revoking erases the bundle and the wraps at
  once, an expired token's go when its owner next makes one; `POST /me/tokens/:id/keys` takes at most
  500 wraps, each for a drawer in scope at a key version the owner holds. A login-password reset, an
  admin's "sign out everywhere" and account deletion end every token (`endAllTokens`).*
- **The command line and device login (PETTY-274, 2026-09-28).** `petty` is one file (`petty.mjs`,
  Node 20+) on `@petty/agent`, shipped with each release and served at `/downloads/petty.mjs`; it
  also runs the MCP server (`petty mcp`). It signs in like `gh auth login` (RFC 8628): the web app's
  `/device` page makes an ordinary access token and seals it to the command line's one-time key, and
  the server only relays the sealed blob. The code is derived from that key (12 of 20 consonants), so
  the page and the command line both detect a swapped key. Only the login is stored
  (`~/.petty/hosts.json`, 600); Tab completion decrypts names per key press, never cached on disk.
  *Since PETTY-276 (2026-11-17) the token itself goes to the system's keychain when there is one, and
  `hosts.json` keeps the rest; see [cli.md](cli.md).*
  *Since PETTY-451 (2026-11-10) the code has 20 of the 20 consonants and is derived from that key and
  the instance's address; the 12-letter form is neither made nor accepted. The command line makes the
  code and sends it with `POST /device/code`; one that sends none is refused by name (400
  `CommandLineTooOld`).*
- **Drawer document history (PETTY-194, 2026-09-19).** Names, items, tags and places before each
  change are kept for 30 days and the drawer's owner can restore an earlier version. Entries and
  balances are unaffected. Refines "Deletion" above for the document only. *Since PETTY-422
  (2026-11-10) the owner's app puts a version back itself, as a normal `PUT /drawers/:id/document`
  with the next counter (see "Drawer format 2"); `POST /drawers/:id/document/restore` answers 410
  `RestoreByApp`.*
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
  *Since PETTY-341 traces drop the client's address and user agent; since PETTY-408 logs and traces
  keep a URL's path without its query string (`safeUrl` in `apps/api/src/lib/tracing.ts`); since
  PETTY-420 the start-up log names only the scheme, host and port of `OTEL_EXPORTER_OTLP_ENDPOINT`.*
- **Version stamped at build (PETTY-218).** The image knows its release (`PETTY_VERSION` from the git
  tag); `/api/config`, Settings and the landing footer show it.
- **Releases (2026-09-23/24; PETTY-254).** Images built by CI with provenance and an SBOM, pinned by
  digest. They were multi-architecture until v1.5.24; since 2026-10-23 (PETTY-385) CI builds the app image
  for linux/amd64 only, because every instance its maintainers run is on x86 and the arm64 build ran under slow QEMU
  emulation. `make image` still builds both, for an ARM board. The backup image (`petty-backup`) stays
  multi-architecture: its nightly job may start on any node of a mixed cluster (PETTY-386). While CI could not run (v1.5.1–v1.5.8), releases were built by hand with the
  same steps (CLAUDE.md, "Releasing"); their provenance names no source revision. A release is started by hand from main and never waits for CI: it is refused
  while `ci.yml` runs on main, or when its latest run there did not pass on main's newest commit. The
  version is the highest `vX.Y.Z` tag plus one patch (a tag pushed by hand starts a new minor or major);
  the workflow makes the release commit, the tag and the GitHub Release. Runtime is Node 26 LTS (since PETTY-346; Node 24 before).
  *Since PETTY-406 no job that runs dependency code holds a write token. Since PETTY-418 (2026-11-10)
  each release signs build attestations for the image and its files (`gh attestation verify`;
  [deploy.md](deploy.md), [cli.md](cli.md)), the app's setup and download links point at the GitHub
  release of the running version, and the image build checks pnpm against a pinned SHA-512
  (`PNPM_SHA512` in the `Dockerfile`). Since PETTY-456 the image takes its version tag only after the
  release commit and its tag are on main.*
- **Agent skill and MCP Registry (PETTY-310/311, 2026-10-04).** The "petty" Agent Skill
  (`apps/mcp/skills/petty/SKILL.md`) is instructions only, no code or secret; it is served at
  `/downloads/petty-skill.zip` and carried by each release. The add-on is listed in the official MCP
  Registry as `io.github.WawRepo/petty`: metadata pointing at the release's `petty.mcpb` and its SHA-256,
  published by `mcp-registry.yml` with GitHub's OIDC login (no secret). There is no hosted (remote) MCP
  connector: it would decrypt on a server, which the threat model rules out.
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
  always pass. The check is soft: writes racing at the limit may overshoot by one record. *Since
  PETTY-442 (2026-11-10) every field a request carries has a size (`FIELD_BYTES` in
  `packages/protocol/src/index.ts`), and an entry (at least 272 bytes) or a document (at least
  16 KiB + 16) cannot be smaller than a client writes it, so every row costs quota. A person's own
  document is at most 256 KiB + 16 and a token bundle 256 KiB. A rotation batch may not grow a row
  past its limit, and what it adds counts against the quota. The table is in [deploy.md](deploy.md),
  "Limits".*
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
- **Several instances, no sticky sessions (PETTY-334, 2026-10-07).** The API keeps nothing a later request
  needs in its own memory: sessions, device logins, custody challenges and the rate and sign-in limits all
  live in Postgres, so any number of instances can run behind a load balancer that spreads requests
  freely. The public instance runs two machines; the custody challenge in memory made every guarded
  action fail when its two requests met different machines. Per-process caches that are only an
  optimisation (the usage-metrics cache, the Clerk client) are allowed.
- **The operator's legal texts belong to the deployment (PETTY-342, 2026-10-07).** Who runs an instance,
  its providers, how long it keeps backups and its terms differ for every operator, so this repository
  carries none of them: an operator puts `privacy.<lang>.md` and `terms.<lang>.md` in `LEGAL_DIR`, and
  the app shows them on `/privacy` and `/terms` and links them at sign-up. Petty's own explanation of
  what the server sees stays on `/privacy` for everyone. The files are rendered from a small Markdown
  subset into elements, never as HTML.
- **The web app trusts what its sealed user document says (PETTY-396 to PETTY-449, 2026-10-28 to
  2026-11-10).** Your own public keys come from your vault, never from `GET /me`. The user document
  (`apps/web/src/lib/pins.ts`) keeps the pins and the keys confirmed before a key change; per drawer,
  the newest key version accepted, a fingerprint of each accepted key, the newest document version and
  counter opened, who was a member and who left; and its own counter inside the encryption (`v` 2). A
  drawer key that someone else wrapped is taken only when that person is confirmed, and not when they
  left and the key is newer than the last one they held. While the document is missing or older than
  this browser saw, the app opens only keys you wrapped and wraps or replaces none. After a removal,
  the owner's app replaces the drawer key at once. Details: [threat-model.md](threat-model.md), "Key
  verification" and "Key rotation".
- **Drawer format 2 (PETTY-422, 2026-11-10).** A drawer's document carries a counter inside the
  encryption and has `schema_version` 2, which the AAD binds; its fixtures are in
  `packages/crypto/corpus/v2`. Only the web app starts the counter; a tool keeps the format it finds.
  The server refuses a document in an older format than the stored one (409 `DocumentFormatOlder`).
  Going back to an image from before v1.5.34 after people used it is not supported (CHANGELOG,
  1.5.34).
- **Same-origin writes (PETTY-409, 2026-11-10).** A request that changes something and carries a
  `Sec-Fetch-Site` other than `same-origin` gets 403 `CrossSiteRequest`, before the session is looked
  up (`apps/api/src/lib/session.ts`). A request without the header (the command line, the add-on, an
  old browser) is left to the JSON-only body rule and the `SameSite=Lax` cookie.
- **Limits per address and per person (security review SR-7; PETTY-303, PETTY-408, PETTY-458).** The
  counts live in `rate_counters`, keyed by a hash. Local sign-in: 10 wrong passwords per email and 100
  tries per address in 15 minutes; a reset email 5 an hour per address it goes to. Every API request:
  `RATE_LIMIT_PER_MINUTE` per address (600 in the image). Stricter: open sign-up 10 an hour per
  address, device codes 10 an hour per address and polls 600 per 15 minutes, device-request looks 60
  per 15 minutes per person, join links 5 an hour per member, email lookups (`POST /users/lookup`)
  `LOOKUP_LIMIT_PER_HOUR` (20) per person and three times that per address. An address is an IPv4
  address or an IPv6 /64 (`clientNet` in `apps/api/src/lib/client-ip.ts`), from `CLIENT_IP_HEADER`
  or else `X-Forwarded-For` as far as `TRUST_PROXY` believes it.
- **Sharing mail limits (PETTY-407, PETTY-423).** Invitation, ownership-offer and join-link emails
  count against three 24-hour windows: one per drawer (a join link: per sender) and recipient,
  `SHARING_MAIL_PER_RECIPIENT` (5) and `SHARING_MAIL_PER_SENDER` (20)
  (`apps/api/src/lib/sharing-mail.ts`). Past one, an invitation or offer still stands and only its
  email is skipped; an emailed join link is refused (429). A new display name is one plain line with
  nothing a mail program turns into a link (`DisplayName` in `packages/protocol`); every email shows
  a name through `mailSafeName`.
- **No email address or link token in a URL; keep less about people (PETTY-341, PETTY-408,
  PETTY-457).** The email lookup is `POST /users/lookup` and the join-link check
  `POST /join-links/lookup`, with the value in the body; join and reset links carry their token after
  `#`. The `GET` forms are gone (404).
  A used join link forgets its email; housekeeping (`apps/api/src/lib/maintenance.ts`) deletes unused
  join links that ended, reset tokens that expired, and drawer documents replaced more than 30 days ago
  (PETTY-488; before, only the drawer's next write dropped them); deleting an account deletes its
  unused join links and reset tokens. What deletion keeps (the account's id, language, dates and
  public keys, so others' records still verify) goes in the first housekeeping run after nothing
  needs it (PETTY-349, `purge_tombstones()` in migration 019): no entry, drawer document or photo,
  kept document version or drawer-key wrap names the person, and no membership, owned drawer,
  transfer or pending invitation is left. Its answered invitations, rotations, used join links and
  revoked tokens go with it.
- **Invitations follow the owner (PETTY-446).** Only the owner invites, an invitation is accepted only
  while its inviter still owns the drawer, and a change of owner ends every pending one. The owner
  lists them with `GET /drawers/:id/invitations` and revokes any with `DELETE /invitations/:id`; the
  web app shows them under Members, where the owner withdraws one (PETTY-498).
- **Clerk accounts need a verified email (PETTY-421).** Drawers are shared by email, so
  `POST /auth/provision` answers 403 `EmailNotVerified` and stores nothing for an address Clerk has
  not verified.
- **The bot check stays on the sign-in pages (PETTY-404); the unlock may stay in memory
  (PETTY-405).** In Clerk mode only `/login` and `/join` allow Cloudflare Turnstile (`AUTH_CSP` in
  `apps/api/src/lib/headers.ts`), and the app leaves them with a full page load, so vault setup and
  unlock never share a page with it. The unlock screen's "Keep the vault open on this device for 24
  hours" is on by default; turned off, the vault lives in page memory only.
- **Where a tool sends its token (PETTY-191, PETTY-416).** `@petty/agent` takes an `https:` address
  only, or `http:` to the same machine (`checkApiUrl`), and `petty-mcp.mjs` stops when
  `PETTY_API_URL` is not set instead of guessing one. `petty auth login` opens only an `http:` or
  `https:` address, never through a shell (PETTY-453). Text that a member or the server wrote reaches
  a model quoted and a terminal with its control characters as `?` (PETTY-414, PETTY-453).
- **Hardened containers (PETTY-420, PETTY-433).** The Compose file runs `app` and `migrate` with a
  read-only file system (only `/tmp`, in memory, is writable), every Linux capability dropped,
  `no-new-privileges`, at most 256 processes and a memory cap (`APP_MEMORY_LIMIT`, 1 GB by default).
  The image runs as `node`, without npm, corepack or yarn, and installs Alpine's package fixes when
  it is built.
- **Email addresses sealed with a server key (PETTY-359).** With `EMAIL_KEY` (32 random bytes, only in
  the app's environment), `users.email` and `join_links.email` are stored as AES-256-GCM ciphertext
  (`email_sealed`) bound to the table, column, row id and key id (`email_key_id`), so a sealed address
  cannot be moved to another row or table. Users also get `email_index`, an HMAC of the address in lower
  case, unique, so sign-in, lookup and "already taken" still find it. HKDF derives the sealing key, the
  index key and the key id from `EMAIL_KEY`; rate-limit keys for an address use the index key too, so no
  table holds a hash of a bare address. One module (`apps/api/src/lib/email-seal.ts`) does every lookup and
  every write; an address is opened only where it is shown or sent. Housekeeping moves rows between the
  forms in batches: plain to sealed, `EMAIL_KEY_OLD` to `EMAIL_KEY`, or back to plain when only
  `EMAIL_KEY_OLD` is set. A lookup matches both forms, so a database part way through works. The app
  refuses to start when a row is under a key it does not have, rather than run unable to sign anyone in.
  Without a key nothing changes: addresses stay plain. Not done: display names stay plain (they are shown
  to drawer members), and the operator who holds the key can still read every address. An HMAC index
  lets the key holder test a guessed address; it does not stop that, only a copy of the database without
  the key.

## Non-goals

- No budget categories, no bank sync, no automatic exchange-rate conversion.
- No server-side plaintext access to drawer content, by design — support and debugging work from error
  classes and ids, never content.
- Not built for large multi-tenant scale. A public instance serves many households, each at household
  scale; several decisions above would need revisiting beyond that.
