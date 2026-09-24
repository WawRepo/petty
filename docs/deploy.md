# Deploying Petty

Petty ships as one container image: the API, the database migrations and the web app.
It needs PostgreSQL 16, an SMTP server and a TLS reverse proxy.

## Docker Compose

```
cp deploy/compose/.env.example deploy/compose/.env    # fill in every value
docker compose -f deploy/compose/docker-compose.yml --env-file deploy/compose/.env up -d
```

- The app listens on `127.0.0.1:3000`. Put Caddy, Traefik or nginx in front of it for HTTPS.
  Passkeys, secure cookies and the service worker need HTTPS.
- The image trusts `X-Forwarded-For` (`TRUST_PROXY=true`) for the client IP. Only run it behind
  a proxy that sets and overwrites that header (Caddy, Traefik and nginx do). Exposed directly, a
  client could spoof it to rotate the per-IP throttle counters (PETTY-201, red-team LOW-2). The
  real brute-force defence does not depend on it: the account lock is keyed by email (10 wrong
  passwords / 15 min), and password reset is capped per email.
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

Open the URL, create the account and its vault. To manage other accounts later (invite, block,
delete), make that account an admin — admins manage accounts but can read no drawer content:

```
docker compose -f deploy/compose/docker-compose.yml --env-file deploy/compose/.env \
  exec app pnpm --filter @petty/api make-admin you@example.com
```

Everyone else joins through a join link you create in the app. For a public instance where anyone
may sign up, set `OPEN_SIGNUP=true` in `deploy/compose/.env` instead.

## Settings

| Variable | Meaning |
|---|---|
| `DATABASE_URL` | migration owner; never used for requests |
| `API_DATABASE_URL` | request role (entries are insert-only for it) |
| `MAINT_DATABASE_URL` | maintenance role (key rotation, deletions) |
| `APP_URL` | public HTTPS address, used in emailed links |
| `CLERK_AUTHORIZED_PARTIES` | clerk mode: comma-separated origins whose Clerk session tokens are accepted; default is the origin of `APP_URL` (PETTY-189) |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM` | outgoing mail |
| `CONTACT_EMAIL` | where "Get an invite" writes to; empty hides the link |
| `AUTH_PROVIDER` | `local` (default) or `clerk`, see `auth-clerk.md` |
| `OPEN_SIGNUP` | local mode only: `true` lets anyone create an account without a join link (a public self-hosted instance). Default off = invite-only. In Clerk mode, open sign-up is a setting in the Clerk dashboard, not here. |
| `CLERK_*` | Clerk keys, only with `AUTH_PROVIDER=clerk` |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | optional OTLP/HTTP endpoint; traces push there when set |
| `OTEL_EXPORTER_OTLP_HEADERS` | auth for that endpoint as an env-format pair, e.g. `Authorization=Basic <token>` |
| `OTEL_PUSH` | `true` also pushes metrics and logs to the OTLP endpoint (a full collector, not a traces-only one) |
| `DEPLOYMENT_ENV` | tags every signal with `deployment.environment` (e.g. `home`, `public`) so two instances don't merge |
| `METRICS_PORT` | optional Prometheus metrics port (`0` = off); not published by the compose file |
| `LOG_LEVEL` | `info` (default), `warn`, `error`, `debug` |

Every variable in this table is passed through by `deploy/compose/docker-compose.yml`; set it in
`deploy/compose/.env` and restart (`up -d`).

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

## Building the image

```
make image TAG=<tag> IMAGE=<registry>/petty      # linux/amd64 and linux/arm64, pushed, digest printed
```
