# syntax=docker/dockerfile:1

# --- BUILD: full deps (incl. dev) + compile TS ---
FROM node:22-alpine AS builder
COPY --from=oven/bun:1-alpine /usr/local/bin/bun /usr/local/bin/bun
WORKDIR /app
# npm "Exit handler never called" / fetch failures are transient registry errors: retry the fetches.
ENV npm_config_fetch_retries=5 \
    npm_config_fetch_retry_mintimeout=20000 \
    npm_config_fetch_retry_maxtimeout=120000
# prisma/ + prisma.config.ts are needed here: the `postinstall` hook runs `prisma generate`.
COPY package.json bun.lock prisma.config.ts ./
COPY prisma ./prisma
RUN --mount=type=cache,target=/root/.bun/install/cache \
    bun install --frozen-lockfile --ignore-scripts
COPY tsconfig.json tsconfig.build.json nest-cli.json ./
COPY src ./src
# prisma.config.ts requires POSTGRES_PASSWORD even for `prisma generate` (no DB connection is made)
RUN POSTGRES_PASSWORD=build-placeholder npm run build && test -f dist/main.js

# --- PROD DEPS: runtime-only node_modules ---
FROM node:22-alpine AS prod-deps
COPY --from=oven/bun:1-alpine /usr/local/bin/bun /usr/local/bin/bun
WORKDIR /app
ENV npm_config_fetch_retries=5 \
    npm_config_fetch_retry_mintimeout=20000 \
    npm_config_fetch_retry_maxtimeout=120000
COPY package.json bun.lock ./
RUN --mount=type=cache,target=/root/.bun/install/cache \
    bun install --frozen-lockfile --production --ignore-scripts

# --- RUNTIME ---
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production \
    PORT=4001 \
    USER_QUEUE=user_queue \
    TUTOR_QUEUE=tutor_queue \
    THIRD_QUEUE=third_queue

COPY --chown=node:node --from=prod-deps /app/node_modules ./node_modules
COPY --chown=node:node --from=builder /app/dist ./dist
COPY --chown=node:node package.json ./

# Required at runtime (pass via --env-file docker.env or compose):
# - POSTGRES_HOST/PORT/DB/USER/PASSWORD (or DATABASE_URL), RABBITMQ_URL
# - JWT_ACCESS_SECRET, JWT_REFRESH_SECRET, JWT_SECRET,
#   JWT_ACCESS_EXPIRES_SECONDS, JWT_REFRESH_EXPIRES_SECONDS
# - FACEBOOK_APP_ID, FACEBOOK_APP_SECRET (app crashes on boot without them)
# - GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_CALLBACK_URL, GOOGLE_OAUTH_REDIRECT_URL

# Git commit this image was built from (passed as build arg by compose). Shown via
# `docker inspect` label and `GIT_COMMIT` env. Kept last so it doesn't bust earlier layers.
ARG GIT_COMMIT=unknown
ENV GIT_COMMIT=${GIT_COMMIT}
LABEL org.opencontainers.image.revision=${GIT_COMMIT}

USER node
EXPOSE 4001
CMD ["node", "dist/main"]
