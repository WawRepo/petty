# A nightly backup job image: pg_dump piped through age (run it on a schedule, e.g. a cron job or a Kubernetes CronJob).
# postgres:16-alpine has neither age nor an openssl CLI, and installing at run time
# would make every backup depend on the internet. Small, pinned, rebuilt rarely:
#   make backup-image     (linux/amd64 and linux/arm64: an arm64-only image once stopped the backup, PETTY-61)
FROM alpine:3.24@sha256:294b683cb724975bec92580e1e685676bd4b50bda910ddb8c51d4cabeaec77e6
RUN apk add --no-cache postgresql16-client age
USER 70:70
