# Changelog

All notable, user-visible changes to Petty. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versions are MAJOR.MINOR.PATCH, but not
strict [Semantic Versioning](https://semver.org/spec/v2.0.0.html): every release raises the patch
number, also when it adds features, and a new minor or major is started by hand (see "Releasing" in
`CLAUDE.md`). Read a release's section before you upgrade.

## [Unreleased]

## [1.5.9] — 2026-10-02

### Changed
- Sign-in through Clerk uses Clerk 6. Its screens look slightly different (for example, the social
  sign-in buttons say "Continue with …"), and a sign-in on a new device may ask for an email code.
  Clerk's code, now with its screens as a package of their own, is still bundled into the app and
  never loaded from Clerk's servers.

### Security
- A general limit on API requests per client address: 600 a minute in the image (`RATE_LIMIT_PER_MINUTE`;
  `0` turns it off). Before, only sign-in, sign-up, password reset and device codes had limits, so one
  address could flood the database through any other route.

## [1.5.8] — 2026-09-30

### Fixed
- Behind Fly.io, 1.5.7 counted every visitor as one address for the per-address limits (in Clerk mode
  the device-login limits), because Fly puts its own addresses at the end of `X-Forwarded-For`. A new
  setting, `CLIENT_IP_HEADER`, names the platform's own header: `Fly-Client-IP` on Fly.io,
  `CF-Connecting-IP` behind Cloudflare.

## [1.5.7] — 2026-09-30

### Fixed
- Self-hosting: the suggested password command (`openssl rand -base64 32`) broke the database
  address about half the time, because of a `/`. The docs now suggest `openssl rand -hex 32`, and
  the migrations and the app name the variable that holds a broken address.
- `make image` sets the image's version; it showed "dev".
- `petty.mcpb` is the same file on every machine that builds it, so the copy an instance serves
  matches the release's `SHA256SUMS`. The MCP server tells AI apps its real version (it said 1.2.0).

### Added
- Settings → About: the version, the licence, the source code of this version, and the third-party
  notices, also for someone who is signed in.

### Changed
- The deploy guide lists the three database passwords, says that mail needs TLS, where the contact
  address is shown, and what admins can do (they cannot delete accounts).
- Source links go to the source of the running version (its tag), not only to the repository. A
  changed version builds the image with `--build-arg VITE_SOURCE_URL=<its repository>`.
- The privacy page and the token switch say all that a writing token can change: a drawer's names,
  items, tags and places, besides adding entries. They named only tags and places.
- The landing page fits every Petty, not only a hosted one: "write to us" shows only when the
  operator gives a contact address, the open sign-up line no longer reads like a hosted offer, and
  the cost answer says that whoever runs a Petty sets its price.
- Licence notices: the web app's list now covers everything it may ship (hash-wasm, the service
  worker's Workbox) and carries the LGPL and GPL texts for the LGPL library in Clerk's sign-in code;
  `petty.mjs` and `petty-mcp.mjs` name their licence and source at the top and end with the notices
  of the packages bundled into them.

### Security
- The per-address limits on sign-in, sign-up, password reset and device codes no longer believe an
  address the client wrote into `X-Forwarded-For`. `TRUST_PROXY` now names the proxies to believe
  (addresses, ranges, or `loopback`, `linklocal`, `uniquelocal`); the image's default, and what
  `true` now means, is proxies on private networks. Behind a CDN, add its ranges.
- The image no longer ships npm, corepack and yarn, and its pnpm is 11.28.2. An image scan (trivy)
  finds no high or critical issue; it found 1 critical and 22 high in 1.5.6. The operator commands
  (`pnpm migrate`, `join-link`, `make-admin`) work as before.

## [1.5.6] — 2026-09-29

### Changed
- One word for what a drawer holds: **item** (the app said "line", "row" and "item"). The drawer
  check is **Checked**: *Mark as checked*, *Not checked yet*, *Checked · 3 days ago*. The entry
  sheet ends with *Check and save* and *Save*; safety numbers say *Compared* and *Numbers match*.
- The security and privacy texts say no more than is true: what the server still sees (your email,
  your name, when entries happen), that a server that changes the app is a different matter, when an
  open vault locks itself, that a password manager that syncs holds the passphrase too, and that an
  AI app reads what its tools fetch.
- Access tokens: *Can make changes* (a writing token can also change tags and move drawers), and a
  new token only reads until you switch that on.
- The emails about a changed password or vault passphrase, or a new sign-in method, tell you to
  reset the password with *Forgot your password?* and name the contact address of your Petty.
- Clearer errors with a next step; plurals that agree ("1 entry … goes", "3 entries … go"); dates in
  British English; commands shown as code; the Places sheets name the place; admin changes say which
  way they go; unused texts removed.
- Polish, German, Spanish and French follow all of this, with the reviewers' fixes: Polish uses
  "Dodaj"/"Wyjmij" (not the cash words) and no gendered forms, French reverses with "Inverser" (not
  "Annuler", which also meant Cancel), German "Tag erstellen" (not "new day"), Spanish agreement in
  the landing examples, a colon with a no-break space in French, and shorter button labels.
- The browser tab names the screen (*Settings · Petty*). It never shows a drawer's or an item's name:
  a tab title is kept in the browser's history on disk.
- The sign-in page says why it is there when a command-line tool is waiting.

### Fixed
- Signing up through Clerk (with GitHub, or with an email code): the code step showed for a moment
  and left an almost empty page. Clerk now moves between its steps inside the app, with no page loads
  in between.
- A bubble in the pictures that shows its name no longer repeats it in a hover tip.
- Contrast: switches that are off, input borders, text on red buttons in the dark theme, links, dark
  sheets against the dimmed page, the landing's phone frames and place pills in the dark theme.
- The drawer picture's top bubble no longer touches the middle one; names in the pictures use the
  room they have; the Home picture is a size smaller on a phone.
- The Home picture: names no longer ride their bubbles across other bubbles, the card keeps its
  height until the bubbles land, and hover names sit above the middle and outside growing bubbles.
- A change of screen no longer shows both top bars at half strength.
- Loading shows the screen's shape: Home remembers how tall its top card was; a drawer and an item
  show placeholders instead of a bare "Loading…".
- 44 px tap targets for the places editor, place trail, chips, picture bubbles, drag handles,
  language menu, the landing demo's tabs and the FAQ rows; the "−" that deletes a place is red, and on
  a phone it gives its room to the place's name (⋯ still has Delete).
- Sheets: labels, checkboxes and radios in the app's style; wrapped labels stay beside their boxes;
  the invite sheet has *Cancel* before the lookup and no form for someone already in the drawer.
- *Delete account* names the drawers that will be deleted, shows *Delete for everyone* in red, and
  has *Cancel*.
- Landing: hero buttons that fit their words, one column of features on a phone, one width for the
  sections on a laptop, the FAQ marker beside a wrapped question, the current language underlined, no
  lone words, and a screenshot strip that no longer clips the frames. Commands on the AI page wrap.
- The 404 page's heading is its message.
- Back from a drawer held the old screen for almost a second when the drawer sits in a place (its
  Home bubble is folded into the place's). Now Home shows at once.
- A new page opens at its top: the privacy page and *Use Petty with AI* opened where the landing
  page was scrolled to. A place on a drawer's trail takes you to Home at its top, where the total is.
- The footer's *Third-party notices* link said "This page does not exist" after the first visit.
- *Change vault passphrase* and *Make a new recovery code* lost what you typed: focus sat on a hidden
  field. In every sheet, focus now stays in the field you type in.
- The keypad stops at the currency's decimals ("1234.5699999 PLN" was refused only at Review), and
  "Enter an amount." shows under the amount, not under the comment.
- Home search finds a drawer by its name or place, with everything in it, and an item by its
  currency or unit.
- A drawer's card leads with its largest amount, in the same order as the totals. Amounts of one
  currency typed as "eur" and "EUR", or with different decimals, add up correctly on the card.
- A dimmed card (outside the place you picked) hides all its amounts, not only the first.
- *Move up* and *Move down* are off at the ends of the list, for items and for places. *Move* for a
  place starts from its own parent (Save moved it to the top level), and Save with no change does nothing.
- Settings: *Sign out* asks first, as the account menu does; *Delete account* looks like the
  dangerous button it is; a too-short export password is marked on the password field.
- Members: the buttons wrap onto a new row instead of squeezing a label into four lines, and
  *Remove* comes last.
- An entry's options have *Cancel*, and *Reverse this entry* is no longer a solid red block.
- `/reset` with no token, or a link cut short, says the link is not valid instead of showing a form
  that could only fail.
- The landing page's screenshot viewer keeps Tab inside, holds the page behind it still, and keeps
  focus on the button you used.
- `/device` keeps its form while it checks a typed code, marks the field with the error, and
  *Denied* has a way back.
- *Use Petty with AI*: the command line's first run calls `~/.local/bin/petty`, which is not on a
  Mac's PATH, and a line says how to add it. The example settings block lost its copy button: its
  paths are made up.
- The privacy page no longer mentions Clerk on a Petty that does not use it.
- *Lock now* no longer throws an error in the background.

## [1.5.5] — 2026-09-28

### Added
- `petty`, a command line for Petty: sign in through your browser the way `gh auth login` works —
  it shows a code, you allow it on a page of your Petty, and no token is copied by hand. Then read
  and change drawers from a terminal, scripts or AI agents: `petty drawers`, `find`, `history`,
  `add`, `take`, `adjust`, `tag`, `move` and more, with `--json`, exit codes and Tab completion for
  bash, zsh, fish and PowerShell. `petty mcp` runs the MCP server with the same login. Download it
  from your Petty (`/downloads/petty.mjs`) or a GitHub release; see docs/cli.md and the app's *Use
  Petty with AI* page.
- The page that allows it, `/device`: it shows what asks and the same code as the terminal, and the
  token it makes is an ordinary access token, listed and revocable in Settings. Opened while signed
  out, it comes back after you sign in and unlock.

## [1.5.4] — 2026-09-28

### Fixed
- A drawer's "+N" bubble opened with a stutter: the lines' names jumped to the other side of their
  bubbles, the spokes of the hidden lines swept across the picture, and every frame laid the page out
  again. Now the bubbles glide on the GPU in straight lines, a name keeps its side while its bubble
  folds away and fades in on the new side, and a spoke fades in once its bubble has landed. The same
  for the Home picture without places.

## [1.5.3] — 2026-09-28

### Fixed
- Back from a drawer to Home jumped: the Home picture was drawn at a guessed width, then at its real
  width in the next frame, so the list below jumped and the bubbles slid across under the drawer
  shrinking into its bubble. The picture is now drawn once, at its real width, every time Home opens.

## [1.5.2] — 2026-09-28

### Added
- A drawer's screen shows where the drawer is — All › Flat › Kitchen — and a tap opens Home at that
  level. Back from a drawer returns to the place it was opened from, and the drawer shrinks back into
  its bubble; Back from a line shrinks it into its place in the drawer's picture.
- Names by the bubbles: a drawer's lines in its picture, and the drawers on the Home picture's first
  ring. A long name is cut short with "…".

### Fixed
- The Home picture's moves were not smooth: every frame laid the page out again (about 50 times per
  move). The bubbles now glide on the GPU, and the page is laid out once per move.

## [1.5.1] — 2026-09-28

### Added
- With places, the Home picture shows them: your places on a ring round the home, and what is in each
  place in small bubbles round it. Tapping a place shows only its drawers, as its chip does, and the
  picture goes one level down; the middle, or a small bubble in the corner, goes back up. Settings →
  Home screen → "Show the picture" turns the picture off.
- Settings has a theme choice: the same as this device, light or dark. It is kept on this device.

### Fixed
- German, Spanish, French and Polish, checked string by string, the emails too: wrong meanings, grammar
  and plural forms, and one word for each thing everywhere (in Polish, 140 of 960 texts changed).
- Landing page: on screens 1280 px and wider, the top part stood to the left of the middle.

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

[Unreleased]: https://github.com/WawRepo/petty/compare/v1.5.9...HEAD
[1.5.9]: https://github.com/WawRepo/petty/releases/tag/v1.5.9
[1.5.8]: https://github.com/WawRepo/petty/releases/tag/v1.5.8
[1.5.7]: https://github.com/WawRepo/petty/releases/tag/v1.5.7
[1.5.6]: https://github.com/WawRepo/petty/releases/tag/v1.5.6
[1.5.5]: https://github.com/WawRepo/petty/releases/tag/v1.5.5
[1.5.4]: https://github.com/WawRepo/petty/releases/tag/v1.5.4
[1.5.3]: https://github.com/WawRepo/petty/releases/tag/v1.5.3
[1.5.2]: https://github.com/WawRepo/petty/releases/tag/v1.5.2
[1.5.1]: https://github.com/WawRepo/petty/releases/tag/v1.5.1
[1.5.0]: https://github.com/WawRepo/petty/releases/tag/v1.5.0
[1.4.2]: https://github.com/WawRepo/petty/releases/tag/v1.4.2
[1.4.1]: https://github.com/WawRepo/petty/releases/tag/v1.4.1
[1.4.0]: https://github.com/WawRepo/petty/releases/tag/v1.4.0
[1.3.4]: https://github.com/WawRepo/petty/releases/tag/v1.3.4
[1.3.3]: https://github.com/WawRepo/petty/releases/tag/v1.3.3
[1.3.2]: https://github.com/WawRepo/petty/releases/tag/v1.3.2
[1.3.1]: https://github.com/WawRepo/petty/releases/tag/v1.3.1
[1.3.0]: https://github.com/WawRepo/petty/releases/tag/v1.3.0
