# syntax=docker/dockerfile:1

# --- BUILD: full deps (incl. dev) + compile TS ---
FROM node:22-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci --legacy-peer-deps --no-audit --no-fund
COPY tsconfig.json tsconfig.build.json nest-cli.json ./
COPY src ./src
RUN npm run build && test -f dist/main.js

# --- PROD DEPS: runtime-only node_modules ---
FROM node:22-alpine AS prod-deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci --omit=dev --legacy-peer-deps --ignore-scripts --no-audit --no-fund

# --- RUNTIME ---
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production \
    PORT=4002 \
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

USER node
EXPOSE 4002
CMD ["node", "dist/main"]
