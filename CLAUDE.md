# CLAUDE.md — user

## Project Overview

**Identity/admin** microservice of a tutoring-platform backend split into 4 independent NestJS
services: `gateway` (HTTP-facing), `user` (this repo — auth/user/admin/student), `tutor-service`
(education domain), `third-service` (notification/email/upload). Built with **NestJS 11** +
**TypeScript**, **PostgreSQL** (Drizzle ORM). This is the only service `gateway` actually calls
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
4. Read database schema only if modifying tables: `../gateway/src/database/schema.ts` (canonical) — `src/database/schema.ts` is a verbatim local mirror of its `users`/`grades`, keep in sync
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
- `../gateway/src/database/schema.ts` — Only when modifying database schema (canonical since 2026-09-28; mirrored locally in `src/database/schema.ts` since 2026-10-05)
- `src/packages/helpers/*` — Only when using specific helpers
- `src/data/constants/*` — Only when adding error/success messages

## Tech Stack

| Layer            | Technology                                              |
| ---------------- | --------------------------------------------------------- |
| Framework        | NestJS 11                                                |
| Language         | TypeScript 5 (strictNullChecks only)                     |
| Database         | PostgreSQL via Drizzle ORM — only `users` + `grades` tables live |
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

# Database (Drizzle) — schema + migrations now live in ../gateway (2026-09-28 consolidation).
# This repo has no local db:generate/db:migrate/db:push/db:studio anymore; run those from
# gateway. See `.claude/rules/database.md`.

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

```
src/
├── main.ts                       # Bootstrap: CORS, interceptors, filters, RMQ listener (user_queue), listen
├── app.module.ts                 # Root module (imports all feature modules)
├── app.controller.ts / app.service.ts   # Health-check
├── database/
│   ├── database.module.ts        # Global Drizzle ORM provider — imports ./schema
│   └── schema.ts                 # Verbatim mirror of gateway's users/grades (gateway stays
│                                  # canonical + owns migrations; mirror exists so Docker builds
│                                  # without ../gateway). Import via `@packages/database/schema`.
├── features/
│   ├── auth/          # HTTP controller + auth.rpc.controller.ts (@MessagePattern responder) + service
│   ├── user/           # HTTP controller + user.rpc.controller.ts + service + repository
│   ├── admin/          # Generic managed-user CRUD (/admin/students, /admin/tutors) + admin.rpc.controller.ts
│   ├── student/        # Student-specific surface (parent linking + profile) + student.rpc.controller.ts
│   └── rabbitmq/        # RmqModule + RmqProducer for outbound RPC to tutor/third-service (copy of gateway's)
└── packages/            # Shared utilities (import via @packages/*): configs, decorators, entities,
                          # filters, guards, helpers, interceptor, interfaces, pipes, strategy
```

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
3. Service → Repository → Drizzle ORM → PostgreSQL
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
  `drizzle/**` files.
- **PostToolUse (Write|Edit)** → `format-ts.mjs` runs prettier + eslint `--fix` on the
  touched `.ts/.js` file.
- **Stop** → `review-skills.mjs` runs after each task that changed `src/`, and asks Claude to
  review/update `.claude/rules/**`, `.claude/skills/**`, `.claude/agents/**`, and memory
  (`MEMORY.md` + memory files) so they stay in sync with new or changed patterns/facts.
