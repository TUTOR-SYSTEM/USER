# Rule: Database & migrations

- **2026-09-28 schema consolidation**: `drizzle.config.ts` + `drizzle/` no longer live in this
  repo — they moved to `../gateway`, which is the canonical owner of the schema + migration
  tooling for the shared Postgres DB (`../gateway/src/database/schema.ts`).
- **2026-10-05 local mirror (for Docker)**: the `@tutor/gateway` (`file:../gateway`) dependency
  was dropped because the Docker build context has no `../gateway`. Instead
  `src/database/schema.ts` is a **verbatim copy** of gateway's `users` + `grades` tables and the
  `userRoleEnum`/`genderEnum` enums, imported via the `@packages/database/*` tsconfig alias:
  `import { users } from '@packages/database/schema'` (`database.module.ts` uses
  `import * as schema from './schema'`). Never hand-edit the mirror to diverge from gateway —
  a hand-written divergent copy (wrong column names/nullability, missing `gradesId`) broke the
  build with 19 type errors and would have mismatched the real DB.
- **To change a table/enum**: edit `../gateway/src/database/schema.ts`, run
  `bun run db:generate` in `gateway` (never here — no local `drizzle.config.ts`/`drizzle-kit`),
  then copy the changed `users`/`grades`/enum definitions into `src/database/schema.ts`. Tell the
  user to run `bun run db:migrate` (or `bun run db:push` for dev) from `gateway`. Do not run
  destructive DB commands automatically.
- **Builds must fail loudly**: keep `"build": "nest build"` and the Dockerfile's
  `RUN npm run build && ...` — masking errors (`|| exit 0`, `;`) makes Docker fail later with the
  misleading `COPY failed: stat app/dist: file does not exist`.
- **Docker gotchas**: `.dockerignore` must NOT exclude `tsconfig.json` (`tsconfig.build.json`
  extends it — without it tsc falls back to defaults and spews ~550 `node_modules/*.d.ts` /
  `esModuleInterop` errors). The image installs with `npm ci --legacy-peer-deps`, which skips
  peer deps — so a runtime-required peer (e.g. `passport` for `@nestjs/passport`) must be listed
  explicitly in `dependencies`.
- All tables use UUID primary keys (`.defaultRandom()`), snake_case column names mapped from
  camelCase TS properties, and `created_at` / `updated_at` timestamps.
- Declare enums as `pgEnum('name', [...])` at the top of `schema.ts` before the tables use them.
- When a where-condition is built conditionally across `if`/`else` branches (e.g. role-based list
  scoping) rather than in one expression, annotate the accumulator explicitly as
  `let scopeWhere: SQL | undefined;` (import `type SQL` from `drizzle-orm`). An untyped `let`
  defaults to implicit `any`, which then makes any `conditions` array holding it `any[]` and
  trips `@typescript-eslint/no-unsafe-argument` the moment it's spread into `and(...conditions)`.
  See `UserRepository.buildUserListConditions` or `AdminRepository`'s list method for the
  reference shape.
- **2026-09-12 schema trim**: `schema.ts` was cut down to just `users` + `grades` — the
  education-scheduling tables (`classes`, `class_students`, `schedules`, `class_sessions`,
  `curriculums`, `chapters`, `lessons`, `tuitions`, `notifications`, `student_scores`,
  `ai_messages`, `attendances`, `exercises`, `conversations`, `conversation_participants`,
  `messages`) and their enums were dropped via a generated migration. See
  `[[trimmed-feature-set]]` memory for why and what to do if these come back.
