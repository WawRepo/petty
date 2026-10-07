# Deploying Petty

Petty ships as one container image: the API, the database migrations and the web app.
It needs PostgreSQL 16, an SMTP server and a TLS reverse proxy.

## Docker Compose

```
cp deploy/compose/.env.example deploy/compose/.env    # fill in every value
docker compose -f deploy/compose/docker-compose.yml --env-file deploy/compose/.env up -d
```

- Make the three database passwords of letters and digits only, for example with
  `openssl rand -hex 32`. Compose puts them into `postgres://` addresses, where `/`, `?`, `#`, `@`
  and `:` break the address (`openssl rand -base64` gives a `/` about half the time). The migrations
  and the app stop with a message that names the variable.

- The app listens on `127.0.0.1:3000`. Put Caddy, Traefik or nginx in front of it for HTTPS.
  Passkeys, secure cookies and the service worker need HTTPS.
- The app takes the client's address from `X-Forwarded-For`, but believes only proxies on private
  networks: `TRUST_PROXY=loopback,linklocal,uniquelocal`, the default (`true` means the same). Your
  reverse proxy connects from such an address (the host through Docker, an ingress pod, a platform's
  proxy), so the address it adds, the client's, counts; whatever the client wrote before it does not.
  Behind a CDN or another proxy on a public address, add its addresses or ranges to the list;
  `false` means no proxy. A client on your own private network looks like a proxy too, so it could
  pick its own address. With a wrong value a client can dodge the per-IP limits on sign-in, sign-up,
  password reset and device codes (PETTY-290). The account lock does not depend on it: it is keyed
  by email (10 wrong passwords / 15 min), and password reset is capped per email.
- Some platforms put their own addresses at the end of `X-Forwarded-For` and give the client's
  address in a header of their own: Fly.io `Fly-Client-IP`, Cloudflare `CF-Connecting-IP`. Name it
  in `CLIENT_IP_HEADER`, and that header counts (PETTY-301). Set it only when the app can be reached
  through that platform alone: anyone who reaches the app directly could write the header.
- The database creates the two runtime roles (`petty_api`, `petty_maint`) on first start,
  with the passwords from the env file. A one-shot `migrate` service runs the migrations as
  the owner before the app starts; the app itself never gets the owner password (PETTY-190).
- Set `PETTY_IMAGE` to a tag and its digest. The Postgres image is pinned by digest too.
- The compose file has no backup service. Add one (see "Backups") before you keep real data.

## First account

Sign-up is invite-only by default, and a fresh database has nobody who could invite you. Mint the
first join link from inside the running API container — it prints a one-time URL, valid 7 days:

```
docker compose -f deploy/compose/docker-compose.yml --env-file deploy/compose/.env \
  exec app pnpm --filter @petty/api join-link you@example.com
```

Open the URL, create the account and its vault. To manage other accounts later (block or unblock
them, end their sessions, restore a vault from its history, make other admins), make that account
an admin — admins manage accounts but can read no drawer content. Deleting an account is up to its
owner (Settings → Delete account):

```
docker compose -f deploy/compose/docker-compose.yml --env-file deploy/compose/.env \
  exec app pnpm --filter @petty/api make-admin you@example.com
```

Everyone else joins through a join link you create in the app. For a public instance where anyone
may sign up, set `OPEN_SIGNUP=true` in `deploy/compose/.env` instead.

## Settings

| Variable | Meaning |
|---|---|
| `OWNER_DB_PASSWORD`, `API_DB_PASSWORD`, `MAINT_DB_PASSWORD` | compose only: the three database passwords, letters and digits only. The database creates its roles with them, and compose builds the three addresses below from them. |
| `DATABASE_URL` | migration owner; never used for requests (built by compose) |
| `API_DATABASE_URL` | request role (entries are insert-only for it) (built by compose) |
| `MAINT_DATABASE_URL` | maintenance role (key rotation, deletions) (built by compose) |
| `APP_URL` | public HTTPS address, used in emailed links |
| `CLERK_AUTHORIZED_PARTIES` | clerk mode: comma-separated origins whose Clerk session tokens are accepted; default is the origin of `APP_URL` (PETTY-189) |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM` | outgoing mail. The server must offer TLS: STARTTLS (usually port 587) or TLS on port 465. Only `localhost`, `127.0.0.1` and `mailpit` may be plain. Mail to a relay without TLS fails; the app logs it, and nobody else sees it. |
| `CONTACT_EMAIL` | the operator's address, shown to everyone: the "Get an invite" buttons, the landing page, `/api/config`, and the security emails ("write to …"). Empty hides all of them. |
| `TRUST_PROXY` | the proxies whose `X-Forwarded-For` the app believes: addresses, CIDR ranges or `loopback`, `linklocal`, `uniquelocal` (the default: all three); `false` = none. See above. |
| `RATE_LIMIT_PER_MINUTE` | API requests per client address per minute, for every route; `0` = off. The image's default is `600`. Over it, the API answers 429 with `Retry-After: 60`. The web app's own files and `/api/health*` do not count. Sign-in, sign-up, password reset and device codes keep their own, stricter limits. |
| `CLIENT_IP_HEADER` | a platform proxy's own client-address header, for example `Fly-Client-IP` or `CF-Connecting-IP`; it wins over `X-Forwarded-For`. Empty (the default) = none. See above. |
| `AUTH_PROVIDER` | `local` (default) or `clerk`, see `auth-clerk.md` |
| `OPEN_SIGNUP` | local mode only: `true` lets anyone create an account without a join link (a public self-hosted instance). Default off = invite-only. In Clerk mode, open sign-up is a setting in the Clerk dashboard, not here. |
| `STORAGE_QUOTA_MB` | per-person storage limit in MB: the encrypted photos, documents (with their 30-day history) and entries in the drawers a person owns; writes by members of a shared drawer count against its owner. Empty = no limit. A photo is at most about 300 KB whatever this says. Each person sees their use in Settings. |
| `CLERK_*` | Clerk keys, only with `AUTH_PROVIDER=clerk` |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | optional OTLP/HTTP endpoint; traces push there when set |
| `OTEL_EXPORTER_OTLP_HEADERS` | auth for that endpoint as an env-format pair, e.g. `Authorization=Basic <token>` |
| `OTEL_PUSH` | `true` also pushes metrics and logs to the OTLP endpoint (a full collector, not a traces-only one) |
| `DEPLOYMENT_ENV` | tags every signal with `deployment.environment` (e.g. `home`, `public`) so two instances don't merge |
| `METRICS_PORT` | optional Prometheus metrics port (`0` = off); not published by the compose file |
| `LOG_LEVEL` | `info` (default), `warn`, `error`, `debug` |

`deploy/compose/docker-compose.yml` passes every other variable in this table to the app; set it in
`deploy/compose/.env` and restart (`up -d`). The image fixes `SECURE_COOKIES=true` (cookies only over
HTTPS).

Metrics, logs and traces are described in `monitoring.md`.

An agent setup (Claude Desktop) is described in `agent.md`.

## Backups

The compose file ships no backup job — add one before you keep real data. `deploy/backup/Dockerfile`
builds a small image with `pg_dump` and `age` so a dump is encrypted before it is written anywhere;
keep the age private key off the server. Drawer content is already ciphertext, but a dump still holds
emails and vault material, so treat it as personal data.

Dump, from the host, as the database owner (`C=docker compose -f deploy/compose/docker-compose.yml --env-file deploy/compose/.env`):

```
$C exec -T db pg_dump -U petty -Fc petty | age -r <your age public key> > petty-$(date +%F).dump.age
```

Restore into the database (stop the app first, then start it again):

```
$C stop app
age -d -i <age private key> petty-<date>.dump.age | $C exec -T db pg_restore -U petty -d petty --clean --if-exists --no-owner
$C start app
```

Test a restore before you need one — restore into a scratch database and count rows. A dump that
exists but does not restore is not a backup. Use a `pg_dump`/`pg_restore` client of the same major
version as the server (this compose file runs PostgreSQL 16); an older client refuses on version skew.

## Upgrading

1. Take a backup (above).
2. In `deploy/compose/.env`, set `PETTY_IMAGE` to the new tag **and** digest from the GitHub release.
3. `$C pull && $C up -d` — the one-shot `migrate` service runs the new migrations as the owner, then
   the app starts on the new image.
4. Check `/api/health` and the version shown in Settings and the landing-page footer.

Downgrading across a migration is not supported: restore the backup from step 1 instead.

## Several instances

The app keeps no state of its own between requests: sessions, device logins, the one-time checks behind
token, passphrase and delete actions, and the request and sign-in limits are all in the database. Run as
many app containers as you like on the same database behind any load balancer; no sticky sessions are
needed. Run `migrate` once per upgrade, before the new containers start.

## Building the image

```
make image TAG=<tag> IMAGE=<registry>/petty      # linux/amd64 and linux/arm64, pushed, digest printed
```

The image reports `<tag>` as its version (Settings, the landing page's footer, `/api/config`).

## Running a changed version (AGPL §13)

If you run a changed Petty for other people, the AGPL asks you to offer them the source of your
version. Build the image with your repository's address, and publish your changes there:

```
docker build --build-arg VITE_SOURCE_URL=https://example.org/you/petty --build-arg PETTY_VERSION=<tag> -t <image> .
```

The web app (landing page, privacy page, Settings → About) and the downloadable command line and MCP
script then link to your source. On GitHub a release version (`v1.2.3`) links the tree at its tag;
on other hosts, the repository. Keep `NOTICE`, `LICENSE` and the notices files as they are built.
