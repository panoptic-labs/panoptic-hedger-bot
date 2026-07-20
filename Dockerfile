# syntax=docker/dockerfile:1

# ============================================================================
# Standalone Dockerfile for the published hedger-bot (panoptic-hedger-bot).
#
# This is the SELF-CONTAINED image: it installs @panoptic-eng/sdk from npm, so
# the build context is just this package (no monorepo workspace needed). The
# monorepo keeps a separate root-context Dockerfile for local development; the
# publish pipeline renames this file to `Dockerfile` in the mirror.
#
# Build:
#   docker build -t hedger-bot .
# Run:
#   docker run --env-file .env hedger-bot
# When using docker-compose.standalone.yml, both local secret source files must
# be owned by uid 1000 and mode 0600; Compose ignores uid/gid/mode overrides for
# file-backed secrets.
# ============================================================================

ARG NODE_IMAGE=node:22-alpine@sha256:16e22a550f3863206a3f701448c45f7912c6896a62de43add43bb9c86130c3e2
FROM ${NODE_IMAGE} AS base

# Corepack resolves the pinned pnpm version from package.json's packageManager.
RUN corepack enable
WORKDIR /app

# -----------------------------------------------------------------------------
# Install dependencies (cached layer). The committed pnpm-lock.yaml pins the
# resolved @panoptic-eng/sdk (from npm) and its transitive deps.
# -----------------------------------------------------------------------------
FROM base AS deps

COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile

# -----------------------------------------------------------------------------
# Production image: copy only executable source/configuration.
# -----------------------------------------------------------------------------
FROM deps AS builder

COPY src ./src
COPY scripts ./scripts
COPY tsconfig.json tsconfig.build.json ./
RUN pnpm build:runtime && pnpm deploy --legacy --prod /opt/hedger

FROM ${NODE_IMAGE} AS runner

ARG SOURCE_SHA
ARG BUILD_VERSION=0.1.0-rc.1
LABEL org.opencontainers.image.revision=$SOURCE_SHA \
      org.opencontainers.image.version=$BUILD_VERSION
RUN printf '%s' "$SOURCE_SHA" | grep -Eq '^[0-9a-f]{40}$'

ENV NODE_ENV=production \
    HEDGER_BUILD_ID=$SOURCE_SHA \
    HEDGER_STATE_DIR=/var/lib/hedger \
    BOT_KEYSTORE_PATH=/run/secrets/bot-keystore \
    BOT_KEYSTORE_PASSPHRASE_FILE=/run/secrets/bot-keystore-passphrase

COPY --from=builder --chown=node:node /opt/hedger /opt/hedger
COPY --from=builder --chown=node:node /app/dist /opt/hedger/dist
RUN mkdir -p /var/lib/hedger && chown node:node /var/lib/hedger

WORKDIR /opt/hedger
USER node
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
  CMD ["node", "dist/scripts/health.js"]
ENTRYPOINT ["node", "dist/src/main.js"]
CMD []
