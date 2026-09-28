# Changelog

All notable, user-visible changes to Petty. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and Petty follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed
- German, Spanish, French and Polish, checked string by string, the emails too: wrong meanings, grammar
  and plural forms, and one word for each thing everywhere (in Polish, 140 of 960 texts changed).

## [1.5.0] — 2026-09-28

### Added
- A drawer can have a colour, picked with its icon ("Icon and colour"): eight, muted like the app's
  green — green (the default), teal, blue, violet, rose, clay, olive and slate, each with a dark-mode
  shade. The drawer's tile on Home, its bubble in the Home picture and the middle of its own picture
  take it. It is stored in the drawer's encrypted document, like the icon; older versions ignore it.
  Lines keep the colour of their kind.

## [1.4.2] — 2026-09-28

### Fixed
- A drawer created right after unlocking, or while the drawers reloaded, could vanish again, its
  screen saying "Something went wrong"; a drawer deleted meanwhile could come back. Two loads of the
  drawers could run at once (Home and the place list each started one), and the slower one wrote an
  older list over the newer. Now one load runs at a time, and a load keeps what was created or deleted
  while it ran.

## [1.4.1] — 2026-09-28

### Fixed
- Landing demo: it did not start on a first visit. It waited until half of the picture or the phone
  was in view, which on a laptop's first screen it is not; it now starts once a little of it shows. A
  mouse anywhere over the wide section held it; now only a mouse over the phone or the icon row does.
  With reduced motion (Windows with "Animation effects" off, for one) it stood still and swapped
  examples by a jump; it now plays there too, with fades only — nothing slides, pops or floats — and
  shows its progress ring.

## [1.4.0] — 2026-09-28

### Added
- German, Spanish and French, next to English and Polish: the whole app, the Clerk sign-in forms and
  every email. A first visit follows the browser's language. A language switch sits at the top of the
  landing page and on every signed-out page; in Settings the choice is also stored on the account, so
  emails follow it.
- Landing page: "One idea, many uses" — a live demo right under the introduction. Six examples (a
  workshop drawer, a trip kitty, yearly accounts, cash at home, things lent out, a family safe) are all
  the same three pieces — a place in the tree, a drawer in it, items in the drawer — each with its own
  shape and its own picture. Going to the next example, the picture's pieces glide to their new places
  while the app view reshapes line by line; after the six, a last picture puts every example around the
  home, next to one drawer from each. Item colours show money, things and notes. The examples are
  picked from a row of their symbols joined to the picture; a pick jumps there and the demo plays on.
  It holds on hover or keyboard focus, stops with its Pause button, and never moves on its own under
  reduced motion.

### Changed
- The app takes the landing page's look. A line's tile has its kind's colour — money green, counted
  things blue, single items amber — and each drawer card shows one dot per line in those colours, with
  a pin by its place. A drawer's screen opens with its picture: the drawer (its photo or icon) in the
  middle and its lines around it, which glide to their new places when the lines change. The Home total
  sits beside the home with its drawers on a ring (on its own when there is no total). A line's screen
  shows its icon in its kind's colour. The pictures work like the landing page's: a bubble opens what it
  shows — a drawer from Home, a line from its drawer — and grows into the next screen's picture; a
  drawer's middle opens its options, and the home clears a picked place. Past six, a picture shows
  five and a "+N": pointing at it (or tapping it) brings those out while the far side of the ring folds
  into a new "+N". Lists come in in turn when a screen opens and a changed amount fades in; reduced
  motion turns all of it off.
- Landing page: a headline about everything you keep, not only cash; the English page no longer talks
  about złoty.

### Fixed
- Seven emails (invitations, join links, handovers and more) went out in English whatever the
  recipient's language; changing the language in Settings did not reach the server; the "Restore the
  version from …" button had a broken screen-reader label.

## [1.3.4] — 2026-09-26

### Added
- Storage limits. The server now refuses a photo over the client's 300 KB limit and an entry over
  16 KiB, whatever sent it. An optional per-person quota, `STORAGE_QUOTA_MB` (off by default), covers
  the encrypted photos, documents and entries in the drawers a person owns; members' writes count
  against the drawer's owner. Settings shows the space used when a quota is set, and a refused write
  says why (also after an offline sync).

## [1.3.3] — 2026-09-25

### Fixed
- The liveness probe `/api/health/live` is no longer logged or traced. It was missed by the probe
  filter, so on a host that probes every few seconds it made up almost all log lines and traces. It is
  still counted in the request metrics.

## [1.3.2] — 2026-09-25

### Added
- Easier AI setup: the "Use Petty with AI" page gives one copy-paste command per operating system to
  download the MCP program into `~/.petty`, and `petty-mcp.mjs --print-config <address>` prints a
  ready settings block with this machine's real paths. Beginner steps for Claude Desktop.
- Each GitHub release now carries the Claude Desktop add-on (`petty.mcpb`), `petty-mcp.mjs`, their
  licence and third-party notices, and `SHA256SUMS`.
- Third-party notices ship with every artifact: the container (LICENSE, NOTICE), the web app
  (`/THIRD_PARTY_NOTICES.md`, linked from the landing page) and the add-on.
- Self-hosting docs: first account, backup, restore and upgrade; every documented setting is now
  passed through `deploy/compose`.

### Changed
- The privacy page no longer promises an operator's backup schedule; it says backups are the
  operator's choice and that account and activity metadata stay visible to the server.
- Node 24 LTS everywhere; the image no longer contains the demo seed scripts; the dev compose file
  binds its services to 127.0.0.1 only.
- Contributions use a DCO sign-off instead of a CLA. The original specification moved to
  `docs/history/`; the maintained threat model and decisions are in `docs/`.

## [1.3.1] — 2026-09-23

### Added
- The running version is shown in the app — the landing footer and the bottom of Settings — and is
  stamped into telemetry (`service.version`). It is baked into the image at build from the release tag,
  so the image always knows its own version.

### Changed
- Telemetry: label-free counters are pre-initialised to 0 on the OTLP push path (parity with the
  Prometheus scrape), and the resource now carries `service.instance.id` so several machines or pods of
  one instance don't collapse into a single metric series.

## [1.3.0] — 2026-09-22

### Added
- Push metrics and logs over OTLP to one `OTEL_EXPORTER_OTLP_ENDPOINT` (traces already did), gated by
  `OTEL_PUSH`, so an instance nothing can scrape from outside (a cloud host) still reports. The
  Prometheus `/metrics` scrape and the stdout JSON logs keep working unchanged, so there is no gap
  while migrating. `DEPLOYMENT_ENV` sets a `deployment.environment` tag on every signal, so several
  instances that share `service.name=petty` (for example a home and a public one) do not merge.

## [1.2.0] — 2026-09-20

First release, published as an image before git tags were used (`v1.3.0` is the first git tag). Petty is an end-to-end-encrypted ledger for physical cash kept in several
places, across currencies, shared per drawer. Highlights of what the 1.2.0 image contains:

### Added
- Access tokens for your own tools, a headless client (`@petty/agent`) and a Claude Desktop
  add-on / MCP server, so an AI assistant can read and write your drawers with the keys held
  only on your machine. Each write token has its own signing key, vouched for by your account.
- "Use Petty with AI" help page, and an "Earlier versions" restore for a drawer's document.
- Make a new recovery code from Settings.
- Sign-in through Clerk as an alternative to the built-in email/passphrase.
- Passkey unlock (WebAuthn PRF), several passkeys per account.
- Places, line tags and per-person Settings (hide totals, verification or places).

### Security
- Fixes from a second internal review on 2026-09-19 (13 findings; that review is not published in
  full — `docs/security-review-2026-09.md` covers the earlier 2026-09-08 one): token key wrapping, token bootstrap scope,
  document history, per-token signing keys, bundled Clerk JS, custody proof on token creation
  and drawer deletion, and more. See `docs/security-review-2026-09.md`.

### Notes
- End-to-end encryption is unchanged: the server stores only ciphertext and cannot read drawer
  content. A lost passphrase and recovery code, on a drawer shared with nobody, is unrecoverable
  by design.

[Unreleased]: https://github.com/WawRepo/petty/compare/v1.5.0...HEAD
[1.5.0]: https://github.com/WawRepo/petty/releases/tag/v1.5.0
[1.4.2]: https://github.com/WawRepo/petty/releases/tag/v1.4.2
[1.4.1]: https://github.com/WawRepo/petty/releases/tag/v1.4.1
[1.4.0]: https://github.com/WawRepo/petty/releases/tag/v1.4.0
[1.3.4]: https://github.com/WawRepo/petty/releases/tag/v1.3.4
[1.3.3]: https://github.com/WawRepo/petty/releases/tag/v1.3.3
[1.3.2]: https://github.com/WawRepo/petty/releases/tag/v1.3.2
[1.3.1]: https://github.com/WawRepo/petty/releases/tag/v1.3.1
[1.3.0]: https://github.com/WawRepo/petty/releases/tag/v1.3.0
