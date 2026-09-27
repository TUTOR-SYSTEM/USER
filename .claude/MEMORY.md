# Backend Memory — user (identity/admin domain)

## Project Structure

```
user/
├── src/
│   ├── main.ts                    # Bootstrap: RabbitMQ microservice on `user_queue`
│   │                              # (deferred init, its own RpcExceptionFilter/TraceContextInterceptor),
│   │                              # CORS, HTTP interceptors/filters, listen (port 8888)
│   ├── app.module.ts              # Root module (imports all feature modules)
│   ├── app.controller.ts          # Health-check controller
│   ├── app.service.ts             # Health-check service
│   ├── database/
│   │   ├── database.module.ts     # Global Drizzle ORM provider
│   │   └── schema.ts              # Live tables: users, grades (everything else trimmed 2026-09-12)
│   ├── features/
│   │   ├── auth/       # HTTP controller + auth.rpc.controller.ts (@MessagePattern responder) + service
│   │                # (also emits fire-and-forget login-session tracking via RabbitMQ — see below)
│   │   ├── user/        # HTTP controller + user.rpc.controller.ts + service + repository
│   │   ├── admin/       # Generic managed-user CRUD (/admin/students, /admin/tutors) + admin.rpc.controller.ts
│   │   ├── student/     # Student-specific surface (parent linking + profile) + student.rpc.controller.ts
│   │   └── rabbitmq/     # RmqModule + RmqProducer (send/emit + trace headers) + rmq.constants.ts
│   │                      # pattern-prefix → queue routing — see "RMQ RPC Plumbing" below
│   └── packages/         # Shared utilities
│       ├── configs/      # JWT sign config
│       ├── decorators/   # @ApiResponse, @Public, @Roles, @CurrentUser decorators
│       ├── entities/     # DTOs + Zod schemas per domain (auth, user, admin, student)
│       ├── filters/      # HttpExceptionFilter, RpcExceptionFilter
│       ├── guards/       # JwtAuthGuard (global), RolesGuard
│       ├── helpers/       # hashing, JWT sign/verify, buildListWhereClause, generateCode
│       ├── interceptor/  # ResponseInterceptor, ErrorInterceptor, LoggerInterceptor
│       ├── interfaces/   # ApiResponseInterface, UserInterface
│       ├── pipes/        # ZodValidationPipe
│       └── strategy/     # Google/Facebook Passport strategies
├── drizzle/               # Auto-generated SQL migrations
├── scripts/                # Seed scripts (Bun runtime) — seed-categories/seed-wallet/seed-edu-flow/
│                            # seed-dashboard/seed-curriculum-demo target tables dropped in the
│                            # 2026-09-12 trim; only seed-user/seed-users-bulk/seed-grades are live
└── test/                   # Jest + Supertest tests
```

## Feature Module Pattern

```
features/{name}/
├── {name}.module.ts          # Module definition
├── {name}.controller.ts      # HTTP route handlers (@Body with ZodValidationPipe)
├── {name}.rpc.controller.ts  # @MessagePattern mirror, reached by gateway's ClientProxy
├── {name}.service.ts         # Business logic (shared by both controllers above)
└── {name}.repository.ts      # Drizzle DB access
```

There is no single canonical reference feature (the old `class` feature was removed in the
2026-09-12 trim) — see `.claude/rules/nestjs-feature-pattern.md` for which of `student`/
`admin`/`user` is the closer shape for a given change, and the `.claude/skills/generate-*/
SKILL.md` self-contained templates.

## RPC contract

This is the only service with live `@MessagePattern` responders today — `auth`, `user`,
`admin`, `student`, all reached by `gateway`'s `RmqProducer` over the `user_queue` RabbitMQ queue — see
"RMQ RPC Plumbing" below. See `../.claude/rules/architecture.md` for the full
naming contract, and the `add-rpc-endpoint` skill (`../.claude/skills/`) when adding or
changing a pattern (update both repos together).

## RMQ RPC Plumbing

Referenced elsewhere as `[[rmq-rpc-plumbing]]`. Inter-service transport is **RabbitMQ**
(`@nestjs/microservices` RMQ transport, request/reply over the `amq.rabbitmq.reply-to` direct
reply queue). History: RabbitMQ → Kafka (2026-09-19) → back to RabbitMQ (2026-09-27). The
`src/features/rabbitmq/` module is a copy of gateway's — keep the two in sync (only
`SERVICE_NAME` differs).

- **Queues**: one durable queue per responder service — `user_queue` (this service),
  `tutor_queue`, `third_queue`. `main.ts` listens on `USER_QUEUE` via `connectMicroservice`
  (`Transport.RMQ`, `prefetchCount: 10`). No topic pre-creation: queues are asserted on connect.
- `src/features/rabbitmq/rmq.producer.ts` — `RmqProducer.send<TResponse, TRequest>(pattern, msg,
  timeoutMs?, maxRetries?)` (request-reply, retries with backoff, rethrows the responder's error
  as a real `HttpException`; 504 on timeout) and `.emit(pattern, msg)` (fire-and-forget). Both
  wrap the payload in an `RmqRecord` whose AMQP `headers` carry `correlationId`/`traceId`/
  `parentTraceId`/`serviceName` — callers never build this themselves.
- `src/features/rabbitmq/rmq.constants.ts` — `RMQ_PREFIX_ROUTES` maps a pattern's first segment
  to the owning service's client/queue (`RMQ_PATTERN_ROUTES` for full-pattern overrides, e.g.
  `kafka.tutor` → tutor). An unrouted prefix throws at call time.
- **Responder side**: `TraceContextInterceptor` reads the headers from
  `RmqContext.getMessage().properties.headers` and the pattern from `getPattern()`.
  `main.ts` opens the microservice with `deferInitialization: true` so `RpcExceptionFilter`/
  `TraceContextInterceptor` are attached *before* `startAllMicroservices()` binds the listeners.
- **`send()` to an `@EventPattern` handler** gets an empty reply, which `RmqProducer.send()`
  treats as a failure. Anything called with `send()` must be a `@MessagePattern` that returns a
  non-undefined value (third-service's `redis.set` returns `{ ok: true }` for this reason).
- `redis.get`/`redis.set`/`redis.del` are **generic KV patterns hosted by third-service**
  (`RedisRpcController` → `RedisService`, backed by `ioredis`) — this repo has no direct Redis
  connection. `AuthService` reuses them for `forgotPasswordService`/`resetPasswordService`
  (reset-token storage, key `reset-password:<jti>`; `redis.set` is awaited so the token exists
  before the email goes out) and for every successful login flow's fire-and-forget
  `emitLoginSessionCreated` (key `session:<userId>` → refreshToken, TTL =
  `jwtTokensConfig.refreshExpiresIn`, errors only logged). Prefer reusing these generic patterns
  for new KV-shaped needs before inventing a new one.

## Environment Variables

| Variable                      | Description                    |
| ----------------------------- | ------------------------------- |
| `NODE_ENV`                    | Environment mode                |
| `PORT`                        | Server port (default `8888`)    |
| `DATABASE_URL`                | Postgres connection URL         |
| `JWT_ACCESS_SECRET` / `JWT_REFRESH_SECRET` | Must match `gateway` (token issuance happens here) |
| `JWT_ACCESS_EXPIRES_SECONDS` / `JWT_REFRESH_EXPIRES_SECONDS` | Token TTLs |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` / `GOOGLE_CALLBACK_URL` / `GOOGLE_OAUTH_REDIRECT_URL` | Google OAuth — final token issuance lands here via RPC from `gateway` |
| `RABBITMQ_URL` | AMQP URL — local `amqp://admin:admin@localhost:5672`; Railway: RabbitMQ service private URL |
| `USER_QUEUE` | Queue this service listens on (default `user_queue`) |
| `TUTOR_QUEUE` / `THIRD_QUEUE` | Queues `RmqProducer` sends to (default `tutor_queue` / `third_queue`) |

No `REDIS_*`/`MAIL_*`/`AWS_*`/`CLOUDINARY_*`/`RESEND_*` vars are read anywhere in `src/` —
password-reset/email and logout-blacklist code paths that would need them were removed (see
`auth.service.ts` comments). Don't configure them speculatively.

## Docker Services

`docker-compose.yml` provides Postgres (`POSTGRES_PORT`, default `5432`) and Redis
(`REDIS_PORT`, default `6380`→`6379`) containers — this repo never opens a Redis client itself;
Redis is reached only indirectly, via RabbitMQ RPC to third-service's generic `redis.*` patterns
(see "RMQ RPC Plumbing" above). The local RabbitMQ broker runs from `../gateway/docker-compose.yml`.

## Testing

- **One runner: Jest** (+ Supertest for e2e). `bun run test`/`test:e2e` both invoke Jest — no
  separate Bun-native test runner, despite older docs having claimed one.
- Unit tests `*.spec.ts`, e2e `*.e2e-spec.ts`, both in `test/`.

## Available Skills

`generate-controller`, `generate-db-table`, `generate-entity`, `generate-feature`,
`generate-module`, `generate-repository`, `generate-service`.

## Available Agents

`dev.md`, `review.md`, `security.md`, `test.md` — see `.claude/agents/`.

## Rules

`conventions.md`, `database.md`, `nestjs-feature-pattern.md` (this repo) plus
`../.claude/rules/architecture.md` and `shared-conventions.md` (cross-service).

## Trimmed Feature Set (2026-09-12)

Referenced elsewhere as `[[trimmed-feature-set]]`. Two unrelated things were removed from this
repo on 2026-09-12, leaving only `auth`/`user`/`admin`/`student` (+ `rabbitmq` infra — see
"RMQ RPC Plumbing" above):

- **Personal-finance features** (`category`, `wallet`, `transaction`) — an earlier, unrelated
  app concept for this repo. Fully deleted: no other service owns these; if they come back,
  they'd be rebuilt from scratch here.
- **Education-scheduling features** (`class`, `schedule`, `session`, `curriculum`, `chapter`,
  `lesson`, `tuition`, `notification`, `attendance`, `exercise`, `chat`, `dashboard`, `report`,
  `agents`) — these were duplicated ownership; per the cross-repo
  `../.claude/rules/architecture.md` table, this domain belongs to `tutor-service` (education)
  and `third-service` (notification), not `user` (identity/admin). Removed here because
  `tutor-service`/`third-service` now have their own live copies with RPC responders wired up
  — this repo keeping them was leftover duplication, not a second source of truth.

Also lost in the same trim: `student`'s class enrollment/scores/session-history fields (that
data now lives with `tutor-service`'s copy of the domain) — `student` here is now just
parent-linking + basic profile.

If any of this needs to come back in `user` specifically (as opposed to just calling
`tutor-service`/`third-service` over RPC), treat it as a new feature via the `generate-*`
skills, not a restore — the old code predates the current RPC-controller/entity conventions.

## Selective File Reading Guideline (IMPORTANT)

**Do NOT read entire source code.** Only read files necessary for the task — see
`CLAUDE.md`'s "IMPORTANT: Selective File Reading" section for the full breakdown.
