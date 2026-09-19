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
| `CLERK_*` | Clerk keys, only with `AUTH_PROVIDER=clerk` |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | optional OTLP/HTTP traces |
| `METRICS_PORT` | optional Prometheus metrics port (`0` = off) |

Metrics, logs and traces are described in `monitoring.md`.

An agent setup (Claude Desktop) is described in `agent.md`.

## Backups

`deploy/backup/Dockerfile` builds a small image that runs `pg_dump` and encrypts the dump
with `age` before it is written anywhere. Keep the age private key off the server. Drawer
content is already ciphertext, but a dump still holds emails and vault material.

## Building the image

```
make image TAG=<tag> IMAGE=<registry>/petty      # linux/amd64 and linux/arm64, pushed, digest printed
```
