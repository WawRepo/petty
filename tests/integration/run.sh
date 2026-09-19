#!/bin/sh
# Integration tests against the production compose file (see README.md in this folder).
#   sh tests/integration/run.sh                       build the working tree and test it
#   PETTY_IMAGE=<ref> sh tests/integration/run.sh     test an image that is already built or pushed
#   PETTY_BASE_IMAGE=<ref> ...                        also: write data with that older image first, then upgrade
#   KEEP=1 ...                                        leave the stack up afterwards (port 3400)
set -eu
cd "$(dirname "$0")"
ROOT=$(cd ../.. && pwd)
# Relative paths: the checkout may sit in a folder with spaces. Everything runs from this folder.
DC="docker compose -p petty-it -f ../../deploy/compose/docker-compose.yml -f compose.test.yml --env-file test.env"
PETTY_IT_COMPOSE=$DC
PETTY_IT_STATE="$(mktemp -d)/state.json"
export PETTY_IT_COMPOSE PETTY_IT_STATE

cleanup() {
  if [ "${KEEP:-}" != 1 ]; then PETTY_IMAGE=unused $DC down -v >/dev/null 2>&1 || true; fi
}
trap cleanup EXIT
PETTY_IMAGE=unused $DC down -v >/dev/null 2>&1 || true

if [ -z "${PETTY_IMAGE:-}" ]; then
  echo "== building the working tree"
  docker build -q -t petty-it:local "$ROOT" >/dev/null
  PETTY_IMAGE=petty-it:local
fi
export PETTY_IMAGE

if [ -n "${PETTY_BASE_IMAGE:-}" ]; then
  echo "== writing data with $PETTY_BASE_IMAGE"
  PETTY_IMAGE=$PETTY_BASE_IMAGE $DC up -d --wait --quiet-pull
  npx vitest run test/01-seed.test.ts
fi

echo "== testing $PETTY_IMAGE"
$DC up -d --wait --quiet-pull   # a new image recreates migrate and app; the database volume stays
npx vitest run
