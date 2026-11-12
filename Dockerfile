# syntax=docker/dockerfile:1.7
# One image: the API serves the built web app and its routes under /api.
#
# Base images are pinned by digest (security review SR-11); bump the tag AND the
# digest together: `docker buildx imagetools inspect node:24-alpine | head -1`.
# The API still runs from TypeScript via tsx (not a tsc build): the workspace
# packages are consumed as source through pnpm links, and a full compile pipeline
# for four packages was judged more risk than the ~1 s of start-up transpilation.
# What DID change: only src/, scripts/ and migrations/ of the API are copied,
# never test/ or the seed, and there is no dev tooling beyond tsx itself.
# Runs on the BUILDER's native arch (not the target), because its only outputs — the web bundle and the
# packed MCP add-on — are plain JS/HTML, identical on every CPU. This keeps the arm64 image off the slow
# QEMU emulation for the heavy vite build; only the small per-arch runtime deps below are emulated.
# pnpm: keep equal to "packageManager" in package.json (the CI setup reads that one).
# PETTY-418: the registry's file is checked against PNPM_SHA512 before anything installs it, so a file
# that changed under the same version stops the build. Bump the version AND the hash together:
#   curl -fsSL https://registry.npmjs.org/pnpm/-/pnpm-<version>.tgz | sha512sum
ARG PNPM_VERSION=11.28.8
ARG PNPM_SHA512=f6988a32046b9a3f78d7d7ee0747926bbe905ff9dff73bf19abb87bd7d1906a2ac90d93f73be32b5f9e14c2899569bcb0c9c5ec8a19e083f5d71bbab6dd9e0b8
# Fetched and checked once, on the builder's CPU. The stages below install pnpm from this file only.
FROM --platform=$BUILDPLATFORM node:24-alpine@sha256:116b800c3754b440ee0aa3ed2f20f5bf3d99a554bfd9adeea09ea8017f6e85f5 AS pnpm
ARG PNPM_VERSION
ARG PNPM_SHA512
RUN npm pack "pnpm@${PNPM_VERSION}" --pack-destination / \
 && echo "${PNPM_SHA512}  /pnpm-${PNPM_VERSION}.tgz" | sha512sum -c - \
 && mv "/pnpm-${PNPM_VERSION}.tgz" /pnpm.tgz

FROM --platform=$BUILDPLATFORM node:24-alpine@sha256:116b800c3754b440ee0aa3ed2f20f5bf3d99a554bfd9adeea09ea8017f6e85f5 AS build
RUN --mount=type=bind,from=pnpm,source=/pnpm.tgz,target=/mnt/pnpm.tgz npm install -g /mnt/pnpm.tgz
WORKDIR /app
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/crypto/package.json packages/crypto/
COPY packages/ledger/package.json packages/ledger/
COPY packages/protocol/package.json packages/protocol/
COPY packages/agent/package.json packages/agent/
COPY apps/mcp/package.json apps/mcp/
COPY apps/cli/package.json apps/cli/
# Every workspace package.json, even unused ones: pnpm 11.28 refuses a frozen lockfile that lists a
# project whose package.json is missing.
COPY tests/integration/package.json tests/integration/
RUN pnpm install --frozen-lockfile
COPY . .
# AGPL section 13 (PETTY-292): a changed version must offer its own source. A fork builds with
# --build-arg VITE_SOURCE_URL=<its repository>; the web app and the downloadable files link there.
ARG VITE_SOURCE_URL=
# The Claude Desktop add-on (PETTY-172) is packed into the web app's public folder, so Petty serves it.
RUN pnpm --filter @petty/mcp run pack
# The command line (PETTY-274), one file, served at /downloads/petty.mjs like the add-on.
RUN pnpm --filter @petty/cli run pack
RUN pnpm --filter @petty/web build

FROM node:24-alpine@sha256:116b800c3754b440ee0aa3ed2f20f5bf3d99a554bfd9adeea09ea8017f6e85f5 AS deps
RUN --mount=type=bind,from=pnpm,source=/pnpm.tgz,target=/mnt/pnpm.tgz npm install -g /mnt/pnpm.tgz
WORKDIR /app
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY apps/api/package.json apps/api/
COPY packages/crypto/package.json packages/crypto/
COPY packages/ledger/package.json packages/ledger/
COPY packages/protocol/package.json packages/protocol/
COPY apps/web/package.json apps/web/
COPY packages/agent/package.json packages/agent/
COPY apps/mcp/package.json apps/mcp/
COPY apps/cli/package.json apps/cli/
COPY tests/integration/package.json tests/integration/
RUN pnpm install --frozen-lockfile --prod --filter @petty/api...

FROM node:24-alpine@sha256:116b800c3754b440ee0aa3ed2f20f5bf3d99a554bfd9adeea09ea8017f6e85f5
# OCI labels (PETTY-211): GHCR reads image.source to link the package to the repo and inherit its visibility.
LABEL org.opencontainers.image.source="https://github.com/WawRepo/petty" \
      org.opencontainers.image.licenses="AGPL-3.0-only" \
      org.opencontainers.image.title="Petty" \
      org.opencontainers.image.description="End-to-end encrypted ledger for physical cash across places and currencies."
# pnpm runs the operator scripts (migrate, join-link, make-admin); the app itself starts as node (CMD).
# npm only installs pnpm; npm, corepack and yarn then leave with their caches, because their bundled
# packages are what image scanners flag (review S9, PETTY-291).
RUN --mount=type=bind,from=pnpm,source=/pnpm.tgz,target=/mnt/pnpm.tgz npm install -g /mnt/pnpm.tgz \
 && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack /opt/yarn-* \
           /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /usr/local/bin/yarn /usr/local/bin/yarnpkg \
           /root/.npm /tmp/*
# PETTY-218: the release version, passed in by release.yml from the git tag; "dev" for local builds.
ARG PETTY_VERSION=dev
# TRUST_PROXY: believe X-Forwarded-For only from proxies on private networks (PETTY-290, lib/trust-proxy.ts).
# pnpm_config_verify_deps_before_run=false: pnpm 11.28 otherwise runs "pnpm install" before every script
# (start, migrate, join-link), which the partial production install always fails as the node user.
ENV NODE_ENV=production API_HOST=0.0.0.0 API_PORT=3000 API_PREFIX=/api WEB_DIST=/app/apps/web/dist TRUST_PROXY=loopback,linklocal,uniquelocal SECURE_COOKIES=true TMPDIR=/tmp PETTY_VERSION=$PETTY_VERSION \
    RATE_LIMIT_PER_MINUTE=600 \
    pnpm_config_verify_deps_before_run=false
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/api/node_modules ./apps/api/node_modules
COPY --from=deps /app/packages ./packages
COPY package.json pnpm-workspace.yaml tsconfig.base.json LICENSE NOTICE ./
COPY apps/api/package.json apps/api/tsconfig.json ./apps/api/
COPY apps/api/src ./apps/api/src
# Only the two operator scripts ship; the seeds (dev/demo data) never enter the image.
COPY apps/api/scripts/join-link.ts apps/api/scripts/make-admin.ts ./apps/api/scripts/
COPY apps/api/migrations ./apps/api/migrations
COPY packages/crypto/src ./packages/crypto/src
COPY packages/ledger/src ./packages/ledger/src
COPY packages/protocol/src ./packages/protocol/src
COPY --from=build /app/apps/web/dist ./apps/web/dist
USER node
EXPOSE 3000
WORKDIR /app/apps/api
# PETTY-418: node is the container's first process, with no package manager and no shell in front of it.
# It is what `pnpm start` ran in the end (tsx's loader, then src/index.ts), which answers a stop itself.
CMD ["node", "--import", "tsx", "src/index.ts"]
