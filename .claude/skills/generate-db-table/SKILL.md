---
name: generate-db-table
description: Add a Drizzle table (and any pgEnum) to the canonical ../gateway/src/database/schema.ts (mirrored into src/database/schema.ts when USER-owned) for a new domain, then generate the migration in gateway. Use when asked to create/add a database table, schema, column, or enum in this NestJS tutoring backend.
---

# Generate Drizzle Table

Add a `pgTable` (and needed `pgEnum`s) to **`../gateway/src/database/schema.ts`** (canonical
schema + migration owner since 2026-09-28). If this repo queries the table, also copy the
definition verbatim into the local mirror `src/database/schema.ts` (exists so the Docker build
doesn't need `../gateway`; never let it diverge). Follow the style of
the existing `users` / `grades` tables (the schema was trimmed down to just these two on
2026-09-12 — see `[[trimmed-feature-set]]` memory).

## Inputs
- Table name (plural, snake_case), e.g. `invoices`.
- Columns with types, nullability, defaults, foreign keys, and any enum values.

## Conventions
- UUID primary key: `id: uuid('id').primaryKey().defaultRandom()`.
- Enums declared at top of file: `export const fooStatusEnum = pgEnum('foo_status', ['A', 'B']);`
  then used as `.status: fooStatusEnum('status').notNull()`.
- Foreign keys: `userId: uuid('user_id').references(() => users.id)`.
- Timestamps:
  ```ts
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
  ```
- Map camelCase TS property → snake_case column name.

## After editing schema.ts
1. Run `bun run db:generate` **in `../gateway`** to emit the migration SQL into its `drizzle/`
   (this repo has no `drizzle.config.ts`/`drizzle-kit`).
2. Sync the changed USER-owned tables/enums into `src/database/schema.ts` here.
3. Tell the user to run `bun run db:migrate` (or `bun run db:push` for dev) from `gateway`.
4. Do NOT hand-edit files in `drizzle/` — they are generated.
