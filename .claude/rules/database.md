# Rule: Database & migrations

- **2026-10 Drizzle → Prisma**: the data layer uses Prisma 7 (engine-less, `@prisma/adapter-pg`).
  `prisma/schema.prisma` maps the existing `users` / `grades` tables and the `user_role` /
  `gender` enums 1:1 (`@@map`/`@map` keep the snake_case column names, including the odd
  `"userCode"`, `"facebookUrl"`, `"googleUrl"` ones). `prisma.config.ts` resolves the URL
  (`DATABASE_URL`, else `POSTGRES_*`). The client is generated into `src/generated/prisma`
  (gitignored) by `prisma generate`, which runs on `postinstall` and in `bun run build`.
- **Migrations are NOT applied from this repo.** The shared DB is still created/migrated from
  `../gateway` (the old `drizzle.config.ts` + `drizzle/` live there). To change a table/enum:
  change gateway's schema + migration, then mirror the change in `prisma/schema.prisma` (or run
  `bun run db:pull` against the migrated DB and review the diff), `bun run db:generate`, and fix
  the repositories. Do not run `prisma db push` / `migrate` against the shared DB.
- **Access pattern**: inject `PrismaService` (from `database.module.ts`, global) into the
  repository — no `@Inject(DRIZZLE)`. Use `select` objects (`satisfies Prisma.UserSelect`) for
  projections that must hide `password`. Role-scoped writes use `updateMany`/`deleteMany`
  (Prisma `update`/`delete` need a unique where), then re-read if the row is needed; `update`
  on a missing row throws `P2025`, which repositories turn into `null`.
- **Error mapping**: `ErrorInterceptor` maps Prisma codes `P2002`/`P2003`/`P2011` (and raw pg
  `23505`/`23503`/`23502`) to friendly messages and hides `Invalid \`prisma.…\`` text.
- **Tests**: mock `PrismaService` with `makePrismaMock()` (`test/support/prisma-mock.ts`); jest
  needs the `.js`-specifier mapper in `jest.config.js` for the generated client.
- **Builds must fail loudly**: keep `"build": "nest build"` and the Dockerfile's
  `RUN npm run build && ...` — masking errors (`|| exit 0`, `;`) makes Docker fail later with the
  misleading `COPY failed: stat app/dist: file does not exist`.
- **Docker gotchas**: `.dockerignore` must NOT exclude `tsconfig.json` (`tsconfig.build.json`
  extends it — without it tsc falls back to defaults and spews ~550 `node_modules/*.d.ts` /
  `esModuleInterop` errors). The image installs with `npm ci --legacy-peer-deps`, which skips
  peer deps — so a runtime-required peer (e.g. `passport` for `@nestjs/passport`) must be listed
  explicitly in `dependencies`.
- All tables use UUID primary keys (`@default(dbgenerated("gen_random_uuid()")) @db.Uuid`),
  snake_case column names mapped from camelCase fields (`@map`), and `created_at` /
  `updated_at` timestamps. Enums are declared as `enum … { @@map("db_name") }`.
- Build conditional where-clauses as `Prisma.UserWhereInput` (`import type { Prisma } from
  '…/generated/prisma/client'`): collect `conditions: Prisma.UserWhereInput[]` and return `{ AND:
  conditions }` (or the single item / `undefined`). Case-insensitive search is `{ contains,
  mode: 'insensitive' }`. See `UserRepository.buildUserListConditions` or `AdminRepository.list`.
- **2026-09-12 schema trim**: `schema.ts` was cut down to just `users` + `grades` — the
  education-scheduling tables (`classes`, `class_students`, `schedules`, `class_sessions`,
  `curriculums`, `chapters`, `lessons`, `tuitions`, `notifications`, `student_scores`,
  `ai_messages`, `attendances`, `exercises`, `conversations`, `conversation_participants`,
  `messages`) and their enums were dropped via a generated migration. See
  `[[trimmed-feature-set]]` memory for why and what to do if these come back.
