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
- The database creates the two runtime roles (`petty_api`, `petty_maint`) on first start,
  with the passwords from the env file. The app runs the migrations on every start.
- Pin `PETTY_TAG` to a release tag or a digest.

## Settings

| Variable | Meaning |
|---|---|
| `DATABASE_URL` | migration owner; never used for requests |
| `API_DATABASE_URL` | request role (entries are insert-only for it) |
| `MAINT_DATABASE_URL` | maintenance role (key rotation, deletions) |
| `APP_URL` | public HTTPS address, used in emailed links |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM` | outgoing mail |
| `CONTACT_EMAIL` | where "Get an invite" writes to; empty hides the link |
| `AUTH_PROVIDER` | `local` (default) or `clerk`, see `auth-clerk.md` |
| `CLERK_*` | Clerk keys, only with `AUTH_PROVIDER=clerk` |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | optional OTLP/HTTP traces |
| `METRICS_PORT` | optional Prometheus metrics port (`0` = off) |

## Backups

`deploy/backup/Dockerfile` builds a small image that runs `pg_dump` and encrypts the dump
with `age` before it is written anywhere. Keep the age private key off the server. Drawer
content is already ciphertext, but a dump still holds emails and vault material.

## Building the image

```
docker buildx build --platform linux/arm64 -t <registry>/petty:<tag> --push .   # add linux/amd64 for x86 hosts
```
