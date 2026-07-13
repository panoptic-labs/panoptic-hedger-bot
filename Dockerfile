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
# ============================================================================

FROM node:22-alpine AS base

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
# Production image: layer the source over the installed node_modules.
# (.dockerignore keeps node_modules/.env/keys out of the COPY.)
# -----------------------------------------------------------------------------
FROM deps AS runner

COPY . .

# Drop root before running the bot. The `node` user ships with the base image.
USER node

# TODO: instead of running with tsx, bundle and run the compiled main.js
ENTRYPOINT ["pnpm", "start"]
CMD []
