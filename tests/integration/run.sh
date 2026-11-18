#!/bin/sh
# Integration tests against the production compose file (see README.md in this folder).
#   sh tests/integration/run.sh                       build the working tree and test it
#   PETTY_IMAGE=<ref> sh tests/integration/run.sh     test an image that is already built or pushed
#   PETTY_BASE_IMAGE=<ref> ...                        also: write data with that older image first, then upgrade
#   PETTY_IT_DOWNLOADS=<folder> ...                   the image serves these files at /downloads (a release's own)
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
  # PETTY-522: as release.yml builds it, with the files for /downloads given as the Dockerfile's downloads
  # stage. Unless PETTY_IT_DOWNLOADS names them, they are that stage's own packs plus one file the stage
  # never makes, so 02-deploy can tell that the given files, not the Dockerfile's packs, fill /downloads.
  if [ -z "${PETTY_IT_DOWNLOADS:-}" ]; then
    PETTY_IT_DOWNLOADS="$(mktemp -d)/downloads"
    docker build -q --target downloads -o "type=local,dest=$PETTY_IT_DOWNLOADS" "$ROOT" >/dev/null
    echo "given to the build, not packed by it (PETTY-522)" > "$PETTY_IT_DOWNLOADS/petty-it-given.txt"
  fi
  docker build -q --build-context "downloads=$PETTY_IT_DOWNLOADS" -t petty-it:local "$ROOT" >/dev/null
  PETTY_IMAGE=petty-it:local
fi
export PETTY_IMAGE PETTY_IT_DOWNLOADS

if [ -n "${PETTY_BASE_IMAGE:-}" ]; then
  echo "== writing data with $PETTY_BASE_IMAGE"
  PETTY_IMAGE=$PETTY_BASE_IMAGE $DC up -d --wait --quiet-pull
  npx vitest run test/01-seed.test.ts
fi

echo "== testing $PETTY_IMAGE"
$DC up -d --wait --quiet-pull   # a new image recreates migrate and app; the database volume stays
npx vitest run
