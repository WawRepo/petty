# Changelog

All notable, user-visible changes to Petty. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and Petty follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/WawRepo/petty/compare/v1.3.2...HEAD
[1.3.2]: https://github.com/WawRepo/petty/releases/tag/v1.3.2
[1.3.1]: https://github.com/WawRepo/petty/releases/tag/v1.3.1
[1.3.0]: https://github.com/WawRepo/petty/releases/tag/v1.3.0
