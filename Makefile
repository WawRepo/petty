SHELL := /bin/bash
export DATABASE_URL       ?= postgres://petty:petty@localhost:5432/petty
export API_DATABASE_URL   ?= postgres://petty_api:petty_api@localhost:5432/petty
export MAINT_DATABASE_URL ?= postgres://petty_maint:petty_maint@localhost:5432/petty

.PHONY: help install db db-wait migrate seed dev test e2e integration image backup-image lint typecheck reset stop demo demo-down demo-reset

help:
	@echo "make dev      start db + mailpit, migrate, run api (:3000) and web (:5173)"
	@echo "make seed     create the three test users"
	@echo "make test     run every test suite (needs db)"
	@echo "make e2e      Playwright end-to-end tests (starts api + web itself)"
	@echo "make lint     eslint + typecheck"
	@echo "make reset    drop the database volume and start clean"
	@echo "make stop     stop containers"
	@echo "make demo     build the image and run the app on http://localhost:3300 with a seeded household"
	@echo "make demo-down / demo-reset   stop it / stop it and drop its data"

install:
	pnpm install --frozen-lockfile

db:
	docker compose up -d db mailpit

db-wait: db
	@until docker compose exec -T db pg_isready -U petty -d petty >/dev/null 2>&1; do sleep 1; done

migrate: db-wait
	pnpm migrate

seed: migrate
	pnpm seed

dev: migrate
	pnpm dev

test: migrate
	pnpm test

e2e: migrate
	pnpm e2e

# PETTY-61: every published image is built for both PCs and servers (amd64) and Raspberry Pis (arm64).
# A single-arch image once stopped the nightly backup on a mixed cluster.
PLATFORMS ?= linux/amd64,linux/arm64
IMAGE ?= ghcr.io/wawrepo/petty
image:
	@test -n "$(TAG)" || { echo "usage: make image TAG=<tag>"; exit 1; }
	docker buildx build --platform $(PLATFORMS) -t $(IMAGE):$(TAG) --push .
	docker buildx imagetools inspect $(IMAGE):$(TAG) | grep -E "^Digest|Platform: +linux"
backup-image:
	docker buildx build --platform $(PLATFORMS) -t $(IMAGE)-backup:1 --push deploy/backup

# The production image under the production compose file, over real HTTP (tests/integration/README.md).
# BASE=<image> also writes data with that older image first and checks it after the upgrade.
integration:
	PETTY_BASE_IMAGE="$(BASE)" sh tests/integration/run.sh

typecheck:
	pnpm typecheck

lint: typecheck
	pnpm lint

stop:
	docker compose down

demo:
	docker compose --profile demo pull app
	docker compose --profile demo up -d
	@docker compose --profile demo wait seed >/dev/null 2>&1; docker compose --profile demo logs --no-log-prefix seed | grep -A3 "seed-demo"
	@echo "open http://localhost:3300  (mail at http://localhost:8025)"

# Deliver bit by bit without CI or the registry: build the image from the working tree and run the demo on it.
demo-local:
	docker compose --profile demo build app
	docker compose --profile demo up -d --no-build
	@docker compose --profile demo wait seed >/dev/null 2>&1; docker compose --profile demo logs --no-log-prefix seed | grep -A3 "seed-demo"
	@echo "open http://localhost:3300  (mail at http://localhost:8025)"

demo-down:
	docker compose --profile demo down

demo-reset:
	docker compose --profile demo down -v

reset:
	docker compose down -v
	$(MAKE) migrate
