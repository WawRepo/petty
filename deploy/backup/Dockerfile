# A nightly backup job image: pg_dump piped through age (the household deployment runs it as a CronJob).
# postgres:16-alpine has neither age nor an openssl CLI, and installing at run time
# would make every backup depend on the internet. Small, pinned, rebuilt rarely:
#   make backup-image     (linux/amd64 and linux/arm64: an arm64-only image once stopped the backup, PETTY-61)
FROM alpine:3.20@sha256:d9e853e87e55526f6b2917df91a2115c36dd7c696a35be12163d44e6e2a4b6bc
RUN apk add --no-cache postgresql16-client age
USER 70:70
