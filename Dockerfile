# syntax=docker/dockerfile:1.7
# One image: the API serves the built web app and its routes under /api.
#
# Base images are pinned by digest (security review SR-11); bump the tag AND the
# digest together: `docker buildx imagetools inspect node:22-alpine | head -1`.
# The API still runs from TypeScript via tsx (not a tsc build): the workspace
# packages are consumed as source through pnpm links, and a full compile pipeline
# for four packages was judged more risk than the ~1 s of start-up transpilation.
# What DID change: only src/, scripts/ and migrations/ of the API are copied,
# never test/ or the seed, and there is no dev tooling beyond tsx itself.
# Runs on the BUILDER's native arch (not the target), because its only outputs — the web bundle and the
# packed MCP add-on — are plain JS/HTML, identical on every CPU. This keeps the arm64 image off the slow
# QEMU emulation for the heavy vite build; only the small per-arch runtime deps below are emulated.
FROM --platform=$BUILDPLATFORM node:22-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32 AS build
RUN npm install -g pnpm@11.2.2
WORKDIR /app
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/crypto/package.json packages/crypto/
COPY packages/ledger/package.json packages/ledger/
COPY packages/protocol/package.json packages/protocol/
COPY packages/agent/package.json packages/agent/
COPY apps/mcp/package.json apps/mcp/
RUN pnpm install --frozen-lockfile
COPY . .
# The Claude Desktop add-on (PETTY-172) is packed into the web app's public folder, so Petty serves it.
RUN pnpm --filter @petty/mcp run pack
RUN pnpm --filter @petty/web build

FROM node:22-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32 AS deps
RUN npm install -g pnpm@11.2.2
WORKDIR /app
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY apps/api/package.json apps/api/
COPY packages/crypto/package.json packages/crypto/
COPY packages/ledger/package.json packages/ledger/
COPY packages/protocol/package.json packages/protocol/
RUN pnpm install --frozen-lockfile --prod --filter @petty/api...

FROM node:22-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32
# OCI labels (PETTY-211): GHCR reads image.source to link the package to the repo and inherit its visibility.
LABEL org.opencontainers.image.source="https://github.com/WawRepo/petty" \
      org.opencontainers.image.licenses="AGPL-3.0-only" \
      org.opencontainers.image.title="Petty" \
      org.opencontainers.image.description="End-to-end encrypted ledger for physical cash across places and currencies."
RUN npm install -g pnpm@11.2.2
ENV NODE_ENV=production API_HOST=0.0.0.0 API_PORT=3000 API_PREFIX=/api WEB_DIST=/app/apps/web/dist TRUST_PROXY=true SECURE_COOKIES=true TMPDIR=/tmp
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/api/node_modules ./apps/api/node_modules
COPY --from=deps /app/packages ./packages
COPY package.json pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/api/package.json apps/api/tsconfig.json ./apps/api/
COPY apps/api/src ./apps/api/src
COPY apps/api/scripts ./apps/api/scripts
COPY apps/api/migrations ./apps/api/migrations
COPY packages/crypto/src ./packages/crypto/src
COPY packages/ledger/src ./packages/ledger/src
COPY packages/protocol/src ./packages/protocol/src
COPY --from=build /app/apps/web/dist ./apps/web/dist
USER node
EXPOSE 3000
WORKDIR /app/apps/api
CMD ["pnpm", "start"]
