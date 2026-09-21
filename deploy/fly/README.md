# Deploying Petty on Fly.io + Neon (PETTY-90 / PETTY-86)

The public product runs the one Petty image on **Fly.io**, with **Neon** for managed Postgres.
This directory has `fly.toml`; the database roles and the secrets are set once, by hand, below.

## 0. Prerequisites (owner)

- A Fly.io account and `flyctl` installed (`brew install flyctl`, then `fly auth login`).
- A Neon account.
- Clerk **production** instance keys (PETTY-139).
- An SMTP sender (e.g. a transactional-email provider), or reuse the current one.

## 1. Neon: project, database, roles

Petty uses three Postgres roles: the **owner** (runs migrations), and two least-privilege runtime
roles `petty_api` (insert-only on entries) and `petty_maint` (rotation/deletion). Migrations
`GRANT` to `petty_api` / `petty_maint` **by name**, so create those roles *before* the first deploy.

1. Create a Neon project; note the database name and the owner connection string.
2. In the Neon SQL editor (or `psql "<owner url>"`), create the runtime roles:
   ```sql
   CREATE ROLE petty_api   LOGIN PASSWORD '<api-password>';
   CREATE ROLE petty_maint LOGIN PASSWORD '<maint-password>';
   ```
   (These replace the dev-only `docker/postgres/init.sql`; the passwords are yours to pick.)
3. Build the three connection strings — **Neon requires TLS, so keep `?sslmode=require`**:
   - owner:  `postgres://<owner>:<pw>@<ep>.neon.tech/<db>?sslmode=require`
   - api:    `postgres://petty_api:<api-pw>@<ep>.neon.tech/<db>?sslmode=require`
   - maint:  `postgres://petty_maint:<maint-pw>@<ep>.neon.tech/<db>?sslmode=require`

pg 8.23 (bundled) honours `sslmode=require`; no code change needed.

## 2. Fly: create the app and set secrets

```
fly apps create petty                      # once; must match `app` in fly.toml
fly secrets set --app petty \
  DATABASE_URL="postgres://<owner>...sslmode=require" \
  API_DATABASE_URL="postgres://petty_api...sslmode=require" \
  MAINT_DATABASE_URL="postgres://petty_maint...sslmode=require" \
  APP_URL="https://<your public origin>" \
  CLERK_AUTHORIZED_PARTIES="https://<your public origin>" \
  CLERK_SECRET_KEY="sk_live_..." \
  CLERK_PUBLISHABLE_KEY="pk_live_..." \
  CLERK_FRONTEND_API="https://clerk.<your domain>" \
  CLERK_JWT_KEY="-----BEGIN PUBLIC KEY-----..." \
  SMTP_HOST="..." SMTP_PORT="587" SMTP_USER="..." SMTP_PASS="..." \
  MAIL_FROM="Petty <no-reply@your-domain>" \
  CONTACT_EMAIL="petty@szatanik.dev"
```

`APP_URL` and `CLERK_AUTHORIZED_PARTIES` must be the exact public origin, or every Clerk sign-in
gets 401 (PETTY-189). `SECURE_COOKIES`, `TRUST_PROXY`, `AUTH_PROVIDER` and the rest come from
`fly.toml` `[env]`.

## 3. Deploy

```
fly deploy --config deploy/fly/fly.toml
```

The `release_command` runs the migrations as the owner first; then the app machine starts and the
health check on `/api/health/live` gates traffic. Deploy a specific released image instead of
building on the machine:

```
fly deploy --config deploy/fly/fly.toml --image ghcr.io/wawrepo/petty:vX.Y.Z@sha256:<digest>
```

(`release.yml` builds and pushes that multi-arch image on a `v*` tag.)

## 4. Domain and TLS

```
fly certs add <your public host> --app petty
```

Add the DNS records Fly prints (A/AAAA or CNAME). Fly terminates TLS; the app already sets HSTS and
secure cookies. Keep the home instance on its own host, unchanged.

## 5. Backups

Neon keeps point-in-time restore on paid plans; enable the retention you want. A logical dump to
your own storage (PETTY-87) is still worth having — the `deploy/backup` image runs `pg_dump | age`
against the owner URL on a schedule.

## Not included here (their own tickets)

Open signup (PETTY-215), Terms of Service (PETTY-216), Stripe billing (PETTY-217),
observability (PETTY-91..94, 98). This ticket is just: the app runs on Fly against Neon.
