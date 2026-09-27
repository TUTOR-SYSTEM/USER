# Rule: NestJS feature pattern

When adding or modifying a feature under `src/features/{name}/`, follow the established
layering — do not invent new shapes. **2026-09-12 trim**: the finance (`category`/`wallet`/
`transaction`) features were already gone, and the education-scheduling side of the domain
(`class`, `schedule`, `session`, `curriculum`, `chapter`, `lesson`, `tuition`, `notification`,
`attendance`, `exercise`, `chat`, `dashboard`, `report`, `agents`) was removed too, along with
their schema tables/entities — see `[[trimmed-feature-set]]` memory for why and what survived.
The live feature set is now `auth`, `user`, `admin`, `student`, plus the `rabbitmq` infra
module (inter-service transport is RabbitMQ — see `[[rmq-rpc-plumbing]]` memory).
**There is no more single canonical reference feature** — `class` (the old one) no
longer exists. Use whichever of `student` (`src/features/student/*`, full controller →
service → repository → module CRUD) or `admin`/`user` (role-aware, "...Service"-suffixed
methods) is the closer shape for what you're building, and lean on the inline code shapes in
`.claude/skills/generate-*/SKILL.md` — those are self-contained templates, not just pointers.

- **Layers**: `{name}.controller.ts` → `{name}.service.ts` → `{name}.repository.ts`, plus
  `{name}.module.ts`. Controllers hold no business logic (they only read `@CurrentUser()` and
  delegate); repositories hold all Drizzle access.
- **Entities live separately** under `src/packages/entities/{domain}/` as
  `{domain}.schema.ts` (Zod), `{domain}.dto.ts` (inferred types), and `index.ts` (barrel).
- **Service methods** are suffixed `...Service` (`createUserService`, `getUsersService`,
  `updateUserService`, see `UserService`) and typically take `{ userId, data | query | id }`;
  they validate the user and ownership before delegating to the repo. (`admin`/`student`
  predate this suffix convention on some methods — follow the suffix for anything new.)
- **Validate optional cross-entity FKs in the service, not the DB.** Before an insert/update,
  check that any optional foreign-key value actually references an existing row — inject the
  owning service (e.g. `UserService.getUserByField`) and throw `NotFoundException` on a miss.
  Never let a bad FK fall through to Postgres (a raw `23503` surfaces as an ugly 500).
  Owner-type FKs (`tutorId`) default to the acting `userId` when omitted; only validate them
  when a different value is passed. (No cross-feature FK example survives the 2026-09 trim —
  `student` no longer has a `classId` to validate — but apply this whenever a new feature adds
  one.)
- **Repository list methods** return `{ <resource>, pagination: { total, page, limit,
  totalPages } }` — the list key is named after the resource (e.g. `students`, `users`), not
  `data`. See `StudentRepository.getAllStudents` / `UserRepository.paginateUsers`.
- **Admin endpoints**: use `@Roles('ADMIN')` decorator (from `@packages/decorators`) +
  `RolesGuard` (from `@packages/guards`) — not a non-existent `@Admin()` decorator.
- **`/students/*` and `/admin/students/*` are two separate, unrelated surfaces** — don't assume
  a fix in one applies to the other. `src/features/student/*` is the normal feature-layered
  student domain (parent linking + basic profile fields only — class enrollment/scores/session
  history were removed in the 2026-09 trim, see `[[trimmed-feature-set]]`). `src/features/admin/*`
  (`AdminController`/`AdminService`/`AdminRepository`) is a *generic* managed-user CRUD shared by
  both `/admin/students` and `/admin/tutors` via a single `ManagedRole` ('TUTOR' | 'STUDENT')
  parameter and one `publicColumns` projection — it has no parent-linking concept by default.
  When a student-only field needs to reach the admin surface, add a dedicated repo method (e.g.
  `findStudentDetail` selecting `parentId`/`address`/`district`/`province`/`tutorId`,
  `findParentInfo` for the linked row) and branch only in the student-specific service method
  (`getStudent`) — don't widen `publicColumns` or the shared `getManagedUser`/`list`/`update`/
  `delete` helpers, since that would also affect Tutors. The same split applies to **update**:
  when the student surface needs more writable fields than the tutor surface, add a dedicated
  `updateManagedStudentSchema` that `.extend()`s the shared `updateManagedUserSchema` (never
  widen the shared one — that leaks student-only fields onto `/admin/tutors/:id`), do the extra
  FK/uniqueness checks (`AdminRepository.existsWithRole`, `findByUserCode`) in the student-only
  service method (`updateStudent`), then delegate to the shared private `updateManagedUser` for
  the actual write (its `dto` param is typed as the union of both schemas so it still accepts the
  wider student payload) and return via `getStudent` for the fully-enriched response. See
  `AdminService.updateStudent` / `updateManagedStudentSchema` (`admin.schema.ts`) as the reference.
- **Role-gated self-update field restriction**: when a self-service update route
  (`@CurrentUser()`-scoped, e.g. `PUT /users`) must forbid one role from changing specific fields
  while an admin-by-id route (`PUT /users/:id`) stays unrestricted, don't add the check to the
  shared write method — wrap it in a dedicated service method (e.g.
  `UserService.updateOwnProfileService({ id, role, data })`) that inspects `data` for the
  forbidden keys, throws `BadRequestException` with a dedicated `ERROR_MESSAGES` entry on a hit,
  and otherwise delegates to the general `updateUserService`. Only the self-update controller
  action calls the wrapper; the by-id action keeps calling the general method directly. See
  `UserService.updateOwnProfileService` (blocks STUDENT from editing `firstName`/`lastName`) as
  the reference.
- **Error messages**: use `ERROR_MESSAGES` constants from `src/data/constants/error.constant.ts`.
  Never hardcode strings in `BadRequestException` / `ConflictException` / etc. For messages with
  dynamic values, compose via template literal: `` `${ERROR_MESSAGES.EMAIL_EXISTS}: ${email}` ``.
- **Success responses**: use `ApiResponse` decorator from `@packages/decorators` for swagger
  metadata. Response body `message` can come from `SUCCESS_MESSAGES` or be inline depending on
  context.
- **List query conditions**: `buildListWhereClause` from `@packages/helpers` is the standard
  helper for search+filter list endpoints. For simple queries (≤2 filters), manual `and()`/`eq()`
  in the repository is acceptable. The `searchableColumns`/`filterColumns` column config is
  built *inside the repository* (it needs the Drizzle table object anyway) — the
  service/controller only pass through `page`/`limit`/`search`/raw filter values from the query
  DTO, never an empty `{}` placeholder. See `StudentRepository.getAllStudents` or
  `AdminRepository`'s list helper as the reference. Also: double-check a `GET .../` controller
  imports its *own* domain's `get{Name}sQuerySchema` / `Get{Name}sQueryDto` — copy-pasting from
  another feature silently drops fields like `search` from validation.
- **Swagger content** lives in `src/data/swaggers/data/{name}.swagger.ts` and
  `src/data/swaggers/messages/{name}.msg.ts`, not inline strings. (Only `user.swagger.ts` /
  `user.msg.ts` survive the 2026-09 trim — `student` currently inlines its Swagger schemas in
  the controller instead; either approach is acceptable, but prefer the data-file pattern for
  new features.)
- **Register** every new module in `src/app.module.ts` `imports: [...]`, and import the
  modules of any sibling services it injects.
- **Route names are plural** (`@Controller('students')`); class/file names are singular.
- Reuse existing helpers — `buildListWhereClause`, `checkUuidValid`, `generateCode`
  (`@packages/helpers`), `ZodValidationPipe` (`@packages/pipes`), `@CurrentUser`/`@Public`/
  `@Admin` (`@packages/decorators`). Never re-implement pagination, validation, or UUID checks,
  and do not use the old `@User` decorator.
- **Infra modules** (`src/features/rabbitmq/*`) are a deliberate exception to the layering
  above — they wrap an external connection, not a domain resource, so there is no repository
  and no controller. `RmqModule` is `@Global()`, registers one `ClientRMQ` per downstream queue
  (`TUTOR_SERVICE` → `tutor_queue`, `THIRD_SERVICE` → `third_queue`, plus `USER_SERVICE`),
  and exports `RmqProducer` so any feature can inject it directly. It is a copy of gateway's
  module — keep them in sync. Inbound handling is plain NestJS `@MessagePattern`/`@EventPattern`
  decorators on each feature's `*.rpc.controller.ts`, served by the RMQ microservice `main.ts`
  opens on `user_queue`.
- **Routing is by pattern prefix** (`RMQ_PREFIX_ROUTES` in `src/features/rabbitmq/rmq.constants.ts`).
  Calling a pattern with a new prefix needs an entry there, or `RmqProducer` throws. There is no
  topic registry or pre-creation step any more — adding a new `@MessagePattern` here needs no
  extra wiring.
- **Calling another service from a feature**: inject `RmqProducer` directly (no import needed,
  it's exported globally). Use `.send<TResponse, TRequest>(pattern, payload)` for request-reply
  (awaited, rethrows the responder's error as a real `HttpException` via `RpcExceptionFilter`'s
  payload) and `.emit(pattern, payload)` for fire-and-forget. A `.send()` target must be a
  `@MessagePattern` returning a non-undefined value — an `@EventPattern` gives an empty reply,
  which `send()` treats as a failure.
  Both wrap the payload with trace headers (`correlationId`/`traceId`/`parentTraceId`) — callers
  never build the envelope themselves. For a **non-critical side effect that must never fail the
  calling flow** (e.g. best-effort cleanup or session tracking), call `.send()`/`.emit()`
  without `await` and attach a `.catch()` that just logs — see `AuthService.resetPasswordService`
  (best-effort `redis.del` cleanup) and `AuthService.emitLoginSessionCreated` (fire-and-forget
  `redis.set` after login) as the reference shape. Define pattern strings as module-level
  `const`s or reuse an existing generic pattern (`redis.get`/`redis.set`/`redis.del`, hosted by
  third-service) rather than inventing a new one when the generic KV patterns already cover the
  need.
