# Integration tests

The production image, started with the production compose file (`deploy/compose/docker-compose.yml`)
plus `compose.test.yml` (the app on port 3400, a mail catcher on 8425), driven over real HTTP. The
point: a change must not break what already works, or what people already stored.

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
| `02-deploy` | health, the one-shot migrate service, no owner password in the app, entries append-only for the API role, security headers, the add-on download, files and the service worker, no caching of API answers |
| `03-household` | login/logout, drawers, entries, an Adjust, sharing with a second person, a stranger kept out, document restore, an access token and the agent (signatures verified), revoke |
| `04-open-signup` | open sign-up without a join link, and the invite path still works |
| `05-storage` | the per-person storage quota fills and refuses |
| `06-cli` | downloads `petty.mjs` from the image, signs in through device login, reads and writes |
| `07-mail` | a password reset through the image, both emails read from the mail catcher, the contact address in them |
| `08-proxy` | per-IP limits count the address the proxy added, not one the client wrote (`TRUST_PROXY`) |
| `09-upgrade` | after an app restart (and the upgrade), the seeded data still logs in, opens and folds to the same balance |
| `10-licences` | the served third-party notices and the licence header and notices of the downloadable files |

Files run in name order. **Every change revises these tests** (see `CLAUDE.md`).
