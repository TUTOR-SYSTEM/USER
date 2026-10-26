---
name: generate-db-table
description: Add a Prisma model (and any enum) to prisma/schema.prisma for a table migrated from ../gateway, then regenerate the client. Use when asked to create/add a database table, schema, column, or enum in this NestJS tutoring backend.
---

# Generate Prisma Model

The shared Postgres schema + migrations are still owned by **`../gateway`** (drizzle there).
This repo only *maps* the tables it queries in **`prisma/schema.prisma`** — it applies no
migrations. Follow the style of the existing `User` / `Grade` models (the schema was trimmed to
just these two on 2026-09-12 — see `[[trimmed-feature-set]]` memory).

## Inputs
- Table name (plural, snake_case), e.g. `invoices`.
- Columns with types, nullability, defaults, foreign keys, and any enum values.

## Conventions
- UUID primary key: `id String @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid`.
- Model names are singular PascalCase with `@@map("table_name")`; fields are camelCase with
  `@map("snake_case")` and an explicit `@db.*` native type (`@db.VarChar(n)`, `@db.Timestamp(6)`…).
- Enums: `enum FooStatus { A B  @@map("foo_status") }`.
- Foreign keys: `userId String @map("user_id") @db.Uuid` + `user User @relation(fields: [userId],
  references: [id], onDelete: Cascade)` — match the `onDelete` of the real constraint.
- Timestamps:
  ```prisma
  createdAt DateTime @default(now()) @map("created_at") @db.Timestamp(6)
  updatedAt DateTime @default(now()) @updatedAt @map("updated_at") @db.Timestamp(6)
  ```

## Steps
1. Add/alter the table in `../gateway` (schema + generated migration) — that is where the DB changes.
2. Mirror it in `prisma/schema.prisma` (or `bun run db:pull` against the migrated DB and review the diff).
3. `bun run db:validate && bun run db:generate` (regenerates `src/generated/prisma`, gitignored).
4. Never run `prisma db push` / `prisma migrate` against the shared DB; tell the user to run
   gateway's `db:migrate` (or `db:push` for dev).
