# Contributing to Petty

Thank you for your interest. Petty is small and opinionated, so please open an issue to discuss a
change before you write a large pull request.

## Before you start

- Read `CLAUDE.md` ("Non-negotiable rules"). Those rules come from the threat model. A change that
  breaks one of them cannot be merged, whatever else it fixes.
- Read `petty-app-spec.md`. Its Decisions log is settled. If you think a decision is wrong, say so
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

- Every user-facing string goes through the English and Polish dictionaries (ICU plurals).
- Clickable elements are `<button>`s; icon-only controls need an accessible name.
- A visible change to a screen updates the landing page captures (see `CLAUDE.md`).
- The ciphertext compatibility corpus in `packages/crypto` must keep passing. Never regenerate
  old fixtures.

## License and contributor agreement

Petty is licensed under the GNU Affero General Public License v3.0 (`LICENSE`).

Before your first pull request can be merged, you will be asked to sign a short Contributor
License Agreement. It lets the maintainers keep offering Petty under the AGPL and, if needed,
under other terms, for example for a hosted service. You keep the copyright to your work.
