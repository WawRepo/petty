# Changelog

All notable, user-visible changes to Petty. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and Petty follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.3.0] — 2026-09-22

### Added
- Push metrics and logs over OTLP to one `OTEL_EXPORTER_OTLP_ENDPOINT` (traces already did), gated by
  `OTEL_PUSH`, so an instance nothing can scrape from outside (a cloud host) still reports. The
  Prometheus `/metrics` scrape and the stdout JSON logs keep working unchanged, so there is no gap
  while migrating. `DEPLOYMENT_ENV` sets a `deployment.environment` tag on every signal, so several
  instances that share `service.name=petty` (for example a home and a public one) do not merge.

## [1.2.0] — 2026-09-20

First tagged release. Petty is an end-to-end-encrypted ledger for physical cash kept in several
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
- Fixes from the 2026-09-19 review (NR-1…NR-13): token key wrapping, token bootstrap scope,
  document history, per-token signing keys, bundled Clerk JS, custody proof on token creation
  and drawer deletion, and more. See `docs/security-review-2026-09.md`.

### Notes
- End-to-end encryption is unchanged: the server stores only ciphertext and cannot read drawer
  content. A lost passphrase and recovery code, on a drawer shared with nobody, is unrecoverable
  by design.

[Unreleased]: https://github.com/WawRepo/petty/compare/v1.2.0...HEAD
[1.2.0]: https://github.com/WawRepo/petty/releases/tag/v1.2.0
