---
name: generate-feature
description: Scaffold a complete NestJS feature module (entity schema/dto, controller, service, repository, module) following this project's exact conventions and wire it into app.module.ts. Use when the user asks to "create a feature", "generate a feature", "add a new module/CRUD", or "scaffold" for this NestJS tutoring backend.
---

# Generate NestJS Feature

Scaffold a full feature module for this backend (an education / tutoring platform). As of a
2026-09-12 trim, the live feature set is just `auth`, `user`, `admin`, `student` (+ the
`rabbitmq` infra module) — the old
`class`/`schedule`/`session`/`curriculum`/etc. features and
their schema tables were removed. There is no single feature that matches this skill's shape
exactly anymore, so **the "Shape to match" section below is the authoritative template** —
use `src/features/student/*` only as a secondary, partial example of the controller → service →
repository → module layering (it predates and doesn't fully follow every convention below).

## Inputs

Ask the user (or infer from the request) before generating:

1. **Feature name** — singular, lowercase (e.g. `session`). Controller route is the plural (`sessions`).
2. **Fields** — name, type, required/optional, validation (min/max/uuid/enum/url/regex).
3. Whether it needs a **Drizzle table** in `src/database/schema.ts` (usually yes for a new domain).
4. Which **sibling services** it depends on (`UserService`, `AdminService`, …) so their
   modules get imported.

If fields are unclear, propose a sensible set and confirm before writing files.

## Composition — run the layer skills in order

This is the orchestrator. Build a feature by applying the focused per-layer skills in
dependency order (each depends on the one above):

1. **generate-db-table** — add the `pgTable`/`pgEnum` to `schema.ts`, generate migration (if a new domain).
2. **generate-entity** — Zod schema + DTOs under `src/packages/entities/{name}/`.
3. **generate-repository** — Drizzle data access.
4. **generate-service** — business logic + validation.
5. **generate-controller** — routes + Swagger.
6. **generate-module** — module file + wire into `app.module.ts`.

The per-layer skills carry the detailed spec; the summary below is the shape to match.

## Naming conventions

For a feature named `foo`:

- Folder: `src/features/foo/`
- Class prefix: `Foo` → `FooController`, `FooService`, `FooRepository`, `FooModule`
- Route: `@Controller('foos')` (plural)
- Entities: `src/packages/entities/foo/` with `foo.schema.ts`, `foo.dto.ts`, `index.ts`
- Drizzle table: `export const foos = pgTable('foos', { ... })`
- Swagger: `src/data/swaggers/data/foo.swagger.ts` (`FOO_SWAGGERS_DATA`) +
  `src/data/swaggers/messages/foo.msg.ts` (`FOO_SWAGGER_MESSAGES`)

## Shape to match

- **Entity** — `createFooSchema`, `updateFooSchema = createFooSchema.partial()`,
  `getFoosQuerySchema` using plain `z.coerce` pagination (NOT `z.preprocess`). Reused enums
  as `z.enum([...])`.
- **Repository** — inject `DRIZZLE`, methods `getFooByField`, `create`, `getFoos`
  (returns `{ foos, pagination }` — list key named after the resource), `getFoo`, `delFoo`.
  Use the object-shaped `buildListWhereClause({ search, searchableColumns, filters, filterColumns })`.
- **Service** — `Logger`, methods suffixed `...Service` (`createFooService`, `getFoosService`,
  `getFooService`, `delFooService`), validate every UUID with `checkUuidValid`, check user +
  ownership, throw `BadRequest`/`NotFound`/`Conflict`. Inject sibling feature services.
- **Controller** — `@ApiTags`, `@ApiBearerAuth('access-token')`, `@Controller('foos')`,
  `@CurrentUser()` for the acting user, `StatusCodes` from `http-status-codes` for `@HttpCode`,
  Swagger fed from the data/message files. `ZodValidationPipe` for every body/query.
- **Module** — import the modules of any injected services, `exports: [FooService]`.

## Wiring (required)

1. **`src/database/schema.ts`** — if a new table is needed, add the `pgEnum`(s) and
   `pgTable('foos', {...})` with a UUID primary key (`.defaultRandom()`), `createdAt` /
   `updatedAt` timestamps, following the style of `users` / `grades`. Then run
   `bun run db:generate` and tell the user to run `bun run db:migrate`.
2. **`src/app.module.ts`** — add `import { FooModule } from './features/foo/foo.module';`
   and insert `FooModule` into the `imports: [...]` array (near the other feature modules).

## After generating

1. Run `bun run lint:check` and `bun run build` (or `bunx tsc --noEmit`) to confirm it compiles.
2. Report exactly which files were created/modified and any migration the user must run.
3. Do NOT invent helpers — reuse `buildListWhereClause`, `checkUuidValid`, `generateCode`
   (`@packages/helpers`), `ZodValidationPipe` (`@packages/pipes`), `@CurrentUser` / `@Public` /
   `@Admin` (`@packages/decorators`) that already exist.
