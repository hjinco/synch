### Self-hosted Synch API: no Cloudflare account required.
#
# Runs the prebuilt Node runtime - libSQL for the app DB, one SQLite file per
# vault for the sync coordinator, and local disk or S3-compatible blob storage.
# Build context is the repo root (this is a pnpm workspace and better-sqlite3
# needs a native build matching this image).
#
#   docker build -f apps/api/Dockerfile -t synch-api .
#
# See docker-compose.yml in this directory for a ready-to-run setup.

FROM node:24-bookworm-slim AS base
RUN corepack enable
WORKDIR /app

FROM base AS native-deps
# better-sqlite3 prefers a prebuilt binary but falls back to compiling from
# source when none matches the target platform/libc (e.g. some arm64 hosts) -
# without a toolchain that fallback fails instead of just being slower.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
	&& rm -rf /var/lib/apt/lists/*

FROM native-deps AS build-deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/www/package.json apps/www/package.json
COPY apps/obsidian-plugin/package.json apps/obsidian-plugin/package.json
COPY packages/tsconfig/package.json packages/tsconfig/package.json
RUN pnpm install --frozen-lockfile --filter @synch/api...

FROM build-deps AS builder
COPY apps/api apps/api
RUN pnpm -C apps/api build:node

FROM native-deps AS production-deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/www/package.json apps/www/package.json
COPY apps/obsidian-plugin/package.json apps/obsidian-plugin/package.json
COPY packages/tsconfig/package.json packages/tsconfig/package.json
RUN pnpm install --frozen-lockfile --filter @synch/api... --prod

FROM base AS runtime
ENV NODE_ENV=production
COPY --from=production-deps /app/node_modules /app/node_modules
COPY --from=production-deps /app/apps/api/node_modules /app/apps/api/node_modules
COPY --from=builder /app/apps/api/dist /app/apps/api/dist
WORKDIR /app/apps/api

EXPOSE 8787
VOLUME /data
ENV DATA_DIR=/data

CMD ["node", "dist/server.mjs"]
