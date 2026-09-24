<!-- Thanks for contributing to Petty. Please open an issue first for anything large. -->

## What and why

<!-- What does this change, and why? Link the issue it closes. -->

Closes #

## Checklist

- [ ] `make lint`, `make test`, and `pnpm --filter @petty/web exec playwright test --project=dev` pass locally.
- [ ] No non-negotiable rule in `CLAUDE.md` is broken (E2EE, append-only entries, server-side permission checks).
- [ ] Every new user-facing string goes through the English **and** Polish dictionaries (ICU plurals).
- [ ] Clickable elements are `<button>`s; icon-only controls have an accessible name.
- [ ] A visible screen change updates the landing-page captures.
- [ ] The ciphertext compatibility corpus in `packages/crypto` still passes (old fixtures untouched).
- [ ] Integration test added or changed — or: not applicable because: <!-- reason -->
- [ ] Every commit is signed off (`git commit -s`, [DCO](https://developercertificate.org/)): I have the right to submit this work under the project's AGPL-3.0 licence.
