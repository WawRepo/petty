# Contributing to Petty

Thank you for your interest. Petty is small and opinionated, so please open an issue to discuss a
change before you write a large pull request.

## Before you start

- Read `CLAUDE.md` ("Non-negotiable rules"). Those rules come from the threat model. A change that
  breaks one of them cannot be merged, whatever else it fixes.
- Read `docs/threat-model.md` and `docs/decisions.md`. The decisions are settled. If you think a decision is wrong, say so
  in an issue instead of implementing something else.
- Security problems go through the private process in `SECURITY.md`, never a public issue.
- This project follows a `CODE_OF_CONDUCT.md`. Be kind.

## Development

See `README.md` for the setup (`pnpm install`, `make dev`). Before you open a pull request:

```
make lint
make test
pnpm --filter @petty/web exec playwright test --project=dev
```

- Every user-facing string goes through the dictionaries in `apps/web/src/i18n/` — English, Polish,
  German, Spanish and French (ICU plurals); `pnpm --filter @petty/web i18n:check` must pass. Emails
  are in `apps/api/src/lib/mail-text.ts`, one catalogue per language.
- Clickable elements are `<button>`s; icon-only controls need an accessible name.
- A visible change to a screen updates the landing page captures (see `CLAUDE.md`).
- The ciphertext compatibility corpus in `packages/crypto` must keep passing. Never regenerate
  old fixtures.

## License and sign-off

Petty is licensed under the GNU Affero General Public License v3.0 (`LICENSE`). Your contribution is
licensed under the same terms (inbound = outbound), and you keep the copyright to your work. There is
no separate agreement to sign.

Every commit carries a [Developer Certificate of Origin](https://developercertificate.org/)
sign-off — your statement that you wrote the change or otherwise have the right to submit it under
the AGPL:

```
git commit -s -m "Fix the thing"
# adds:  Signed-off-by: Your Name <you@example.com>
```

Forgot it? `git commit --amend -s` (last commit) or `git rebase --signoff main` (a whole branch).

## Tracking and decisions

Ticket IDs such as `PETTY-123` refer to the maintainers' internal tracker; you do not need access to
it. The public trail is this repository's issues, pull requests and `CHANGELOG.md`, and the settled
design decisions are in `docs/decisions.md` (reasoning for the early ones: [SPEC-ISSUES.md](docs/history/SPEC-ISSUES.md)).
