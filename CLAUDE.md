# CLAUDE.md — user

## Project Overview

**Identity/admin** microservice of a tutoring-platform backend split into 4 independent NestJS
services: `gateway` (HTTP-facing), `user` (this repo — auth/user/admin/student), `tutor-service`
(education domain), `third-service` (notification/email/upload). Built with **NestJS 11** +
**TypeScript**, **PostgreSQL** (Prisma ORM). This is the only service `gateway` actually calls
today — its `auth`/`user`/`admin`/`student` RPC handlers are live and working end-to-end.

This repo previously described a personal-finance app ("My Finance Tracker" —
categories/wallets/transactions), then briefly an education-scheduling monolith
(`class`/`schedule`/`session`/etc.); both are gone. **2026-09-12 trim** cut it down to just
`auth`/`user`/`admin`/`student` + the schema down to `users`/`grades` (see
`.claude/rules/database.md` and `[[trimmed-feature-set]]` memory). The `.claude/rules/*.md`
files were kept in sync with this; this `CLAUDE.md` was not, until now.

## IMPORTANT: Selective File Reading

**Do NOT read entire source code.** Only read files necessary for the current task:

### When working on a feature:
1. Read `CLAUDE.md` and `.claude/rules/*.md` for conventions
2. Read the specific feature module: `src/features/{name}/*`
3. Read related entities: `src/packages/entities/{name}/*`
4. Read database schema only if modifying tables: `prisma/schema.prisma` (this repo's Prisma mapping of `users`/`grades`); the DB itself is still migrated from `../gateway`
5. Read `app.module.ts` only when registering new modules
6. If the feature is reached from `gateway`, read the matching `*.rpc.controller.ts` here to
   see the actual `@MessagePattern` contract, and cross-check against `gateway`'s
   `rmqProducer.send(...)` call site (sibling repo, `../gateway/`) when changing either side.

### When fixing a bug:
1. Read the specific file with the bug
2. Read related files only if needed for context
3. Do NOT read unrelated features

### When adding a new feature:
1. Use `generate-*` skills first (they encode the patterns)
2. Read only the reference feature mentioned in `.claude/rules/nestjs-feature-pattern.md`
   (there is no single canonical feature since the 2026-09-12 trim — see that rule)
3. Read `src/app.module.ts` to register the new module

### Files to read ONLY when necessary:
- `src/main.ts` — Only when changing bootstrap or the RMQ listener setup
- `src/app.module.ts` — Only when adding/removing modules
- `prisma/schema.prisma` — Only when modifying database schema (must stay in sync with the tables migrated from `../gateway`)
- `src/packages/helpers/*` — Only when using specific helpers
- `src/data/constants/*` — Only when adding error/success messages

## Tech Stack

| Layer            | Technology                                              |
| ---------------- | --------------------------------------------------------- |
| Framework        | NestJS 11                                                |
| Language         | TypeScript 5 (strictNullChecks only)                     |
| Database         | PostgreSQL via Prisma 7 (`@prisma/adapter-pg`, generated client in `src/generated/prisma`) — only `users` + `grades` models live |
| Inter-service    | RabbitMQ RPC (`@nestjs/microservices`, RMQ transport) — the only service with live `@MessagePattern` responders (`auth`/`user`/`admin`/`student`), reached by `gateway`'s `USER_SERVICE` client on `user_queue`. Calls `tutor-service`/`third-service` via `RmqProducer` (`src/features/rabbitmq/`). |
| Authentication   | Passport JWT (access + refresh) — token issuance lives here; `gateway` verifies locally and calls back here to confirm the user exists |
| Validation       | Zod v4 (via custom `ZodValidationPipe`)                  |
| API Docs         | @nestjs/swagger (note: title/description in `main.ts` still say "financial management system" — stale, harmless) |
| Package Manager  | Bun (runtime) / npm (lock file present)                  |
| Testing          | Jest (unit + e2e) + Supertest — **not** a separate Bun-native runner |
| Formatting       | Prettier (single quotes, trailing commas)                |
| Linting          | ESLint + typescript-eslint                               |
| Containerization | Docker Compose / Podman Compose (Postgres + Redis — Redis/email/Cloudinary/AWS packages are installed but **not currently used**: password-reset and logout-blacklist code paths that would need Redis/email were removed, see `auth.service.ts` comments) |

## Commands

```bash
# Development
bun start:dev             # Start dev server with watch
bun start:debug           # Start with debug + watch
bun run build             # Production build
bun run start:prod        # Run compiled JS

# Code Quality
bun run lint              # ESLint with --fix
bun run lint:check        # ESLint without fix (CI-friendly)
bun run format             # Prettier write
bun run format:check      # Prettier check

# Testing
bun run test              # Unit tests (Jest)
bun run test:watch        # Unit tests in watch mode
bun run test:cov          # Unit tests with coverage
bun run test:e2e          # E2E tests
bun run test:debug        # Debug tests with inspect

# Database (Prisma) — prisma/schema.prisma maps onto the existing users/grades tables.
bun run db:generate       # prisma generate → src/generated/prisma (gitignored; also runs on
                          # postinstall and as part of `bun run build`)
bun run db:validate       # prisma validate
bun run db:pull           # prisma db pull — re-introspect the shared DB
bun run db:studio         # Prisma Studio
# This repo applies NO migrations: the shared DB schema is still created/migrated from ../gateway.
# See `.claude/rules/database.md`.

# Database Seeds (scripts/*.ts, Bun runtime)
bun run db:seed:user / users-bulk / grades
# seed-categories.ts / seed-wallet.ts still target tables that don't exist anywhere (dead,
# commented out even in gateway's merged schema) — do not run them. seed-edu-flow.ts /
# seed-dashboard.ts / seed-curriculum-demo.ts now type-check again (their tables live in
# gateway's merged schema), but they seed tutor-service-owned tables, not anything this repo
# queries — only run them if you actually want that cross-service seed data.

# Containers (Postgres + Redis)
bun compose:up / compose:down
bun podman:up / podman:down / podman:logs
```

## Project Structure

Gotchas:
- `prisma/schema.prisma` maps the existing `users`/`grades` tables (no migrations here — gateway owns them). Repositories inject `PrismaService` (`src/database/prisma.service.ts`, exported from `database.module.ts`) and use `this.db.user` / `this.db.grade`; types come from `src/generated/prisma/client`.
- Each feature is an HTTP controller + `*.rpc.controller.ts` (the `@MessagePattern` responder) + service. `admin` is generic managed-user CRUD (`/admin/students`, `/admin/tutors`); `student` covers parent linking and profile.
- `features/rabbitmq/` is a copy of gateway's RmqModule, used for outbound RPC to tutor-service and third-service.

## Code Conventions

See `.claude/rules/conventions.md` and `.claude/rules/nestjs-feature-pattern.md` — both already
accurately describe the post-trim `auth`/`user`/`admin`/`student` domain in detail (the
admin/student split, self-update field restrictions, etc.). Summary: `@packages/*` alias, Zod v4
via `ZodValidationPipe`, JWT auth with `@Public()`/`@Roles('ADMIN')`,
`ERROR_MESSAGES`/`SUCCESS_MESSAGES` constants, Prettier single-quote/100-width enforced by a
PostToolUse hook.

### Request/Response Flow (HTTP path)

1. Request → Global `JwtAuthGuard` (unless `@Public()`)
2. Controller validates body via `ZodValidationPipe`
3. Service → Repository → Prisma (`PrismaService`) → PostgreSQL
4. `ResponseInterceptor` wraps the response the same way for both the HTTP controller and the
   RPC controller's underlying service call.
5. Errors handled by `ErrorInterceptor` + `HttpExceptionFilter` (HTTP) or `RpcExceptionFilter`
   (RPC, translated back into an `HttpException` by `gateway`'s `RmqProducer.send`).

### RPC contract (see also `../.claude/rules/architecture.md`)

Each feature's `*.rpc.controller.ts` is a thin `@MessagePattern('<feature>.<methodName>')`
mirror of its HTTP controller, delegating to the *same* `*Service` class — no duplicated logic.
When adding or renaming a pattern here, update `gateway`'s matching `rmqProducer.send(...)` call site in
the same change (use the `add-rpc-endpoint` skill in `../.claude/skills/`) — nothing enforces
the pattern string across repos, so a mismatch fails at runtime with "no matching message handler".

## Environment Variables

| Variable                      | Description                    |
| ----------------------------- | ------------------------------- |
| `NODE_ENV`                    | Environment mode                |
| `PORT`                        | Server port (default `8888` — must be unique when running alongside the other 3 services) |
| `SERVICE_HOST`                | Optional service address reported in request logs (`host`), e.g. `user-service:50051` (default `user-service:${PORT}`) |
| `DATABASE_URL`                | Postgres connection URL         |
| `JWT_ACCESS_SECRET` / `JWT_REFRESH_SECRET` | Must match `gateway`'s secrets (token issuance happens here) |
| `JWT_ACCESS_EXPIRES_SECONDS` / `JWT_REFRESH_EXPIRES_SECONDS` | Token TTLs |
| `LOGIN_MAX_ATTEMPTS` / `LOGIN_ATTEMPT_WINDOW_SECONDS` | Failed sign-ins per account before lockout (default 5) and the window length in seconds (default 900). Counter lives in `third`'s Redis (`login-fail:<sha256>`). |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` / `GOOGLE_CALLBACK_URL` / `GOOGLE_OAUTH_REDIRECT_URL` | Google OAuth (final token issuance lands here via RPC from `gateway`) |
| `RABBITMQ_URL`                | RabbitMQ connection URL (local `amqp://admin:admin@localhost:5672`; Railway: RabbitMQ service private URL) |
| `USER_QUEUE`                  | RMQ RPC listener queue name (default `user_queue`) — this is the queue `gateway`'s `USER_SERVICE` client actually talks to |
| `TUTOR_QUEUE` / `THIRD_QUEUE` | Queues this service's `RmqProducer` sends to (default `tutor_queue` / `third_queue`) |

No `REDIS_*`, `AWS_*`, `CLOUDINARY_*`, `MAIL_*`, or `RESEND_*` vars are read anywhere in `src/`
despite the matching packages being installed — password-reset/email and logout-blacklist paths
that would need them were removed (see `auth.service.ts` comments). Don't add them speculatively.

## Project Rules

@.claude/rules/nestjs-feature-pattern.md
@.claude/rules/database.md
@.claude/rules/conventions.md

## Automated Hooks

Configured in `.claude/settings.json` (scripts in `.claude/hooks/`):

- **PreToolUse (Write|Edit)** → `guard-paths.mjs` blocks edits to `.env*` and generated
  `drizzle/**` files (legacy).
- **PostToolUse (Write|Edit)** → `format-ts.mjs` runs prettier + eslint `--fix` on the
  touched `.ts/.js` file.
- **Stop** → `review-skills.mjs` runs after each task that changed `src/`, and asks Claude to
  review/update `.claude/rules/**`, `.claude/skills/**`, `.claude/agents/**`, and memory
  (`MEMORY.md` + memory files) so they stay in sync with new or changed patterns/facts.
