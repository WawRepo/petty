# A nightly backup job image: pg_dump piped through age (run it on a schedule, e.g. a cron job or a Kubernetes CronJob).
# postgres:16-alpine has neither age nor an openssl CLI, and installing at run time
# would make every backup depend on the internet. Small and pinned. CI rebuilds it when this folder
# changes and monthly (.github/workflows/backup-image.yml, PETTY-365); to build your own:
#   make backup-image     (linux/amd64 and linux/arm64: an arm64-only image once stopped the backup, PETTY-61)
FROM alpine:3.24@sha256:be2656061b536c1883c4034790e21d0a09c5aaaf51968b89368a3c0371ea2c9a
RUN apk add --no-cache postgresql16-client age
USER 70:70
