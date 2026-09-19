# Integration tests

The production image, started with the production compose file (`deploy/compose/docker-compose.yml`)
plus `compose.test.yml` (a mail catcher, port 3400), driven over real HTTP. The point: a change must
not break what already works, or what people already stored.

```
make integration                                      # build the working tree, test it
make integration BASE=ghcr.io/wawrepo/petty:<tag>     # write data with <tag> first, then upgrade and check it
PETTY_IMAGE=<ref> sh tests/integration/run.sh         # test an image that is already built or pushed
KEEP=1 sh tests/integration/run.sh                    # leave the stack up afterwards
```

Needs Docker and `pnpm install`. The stack is the compose project `petty-it`; it is removed with its
volume at the end. `test.env` holds test-only passwords.

| File | Covers |
|---|---|
| `01-seed` | writes one account, drawer and two entries (with `BASE`, on the older image) |
| `02-deploy` | health, the one-shot migrate service, no owner password in the app, entries append-only for the API role, security headers, the add-on download |
| `03-household` | login/logout, drawers, entries, an Adjust, sharing with a second person, a stranger kept out, document restore, an access token and the agent (signatures verified), revoke |
| `09-upgrade` | after an app restart (and the upgrade), the seeded data still logs in, opens and folds to the same balance |

Files run in name order. **Every change revises these tests** (see `CLAUDE.md`).
