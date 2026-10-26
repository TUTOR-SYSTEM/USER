---
name: generate-repository
description: Scaffold the repository layer (src/features/{name}/{name}.repository.ts) — Prisma DB access via PrismaService, CRUD + paginated list using buildListWhereClause. Use when asked to create/add a repository or data-access layer for a feature in this NestJS tutoring backend.
---

# Generate Repository

Create `src/features/foo/foo.repository.ts`. The `class` feature this skill originally
mirrored was removed in a 2026-09-12 trim — follow the shape below; `student.repository.ts` /
`user.repository.ts` are the closest surviving examples of `buildListWhereClause` +
pagination.

## Prerequisites
- The Prisma model (e.g. `Foo` → `this.db.foo`) exists in `prisma/schema.prisma` and `bun run db:generate` has been run (the table itself is migrated from `../gateway`).
- The DTOs exist under `@packages/entities/foo` (see `generate-entity`).

## Shape
```ts
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../database/database.module';
import type { Prisma } from '../../generated/prisma/client';
import { CreateFooDto, GetFoosQueryDto } from '@packages/entities/foo';
import { buildListWhereClause } from '@packages/helpers';

@Injectable()
export class FooRepository {
  constructor(private readonly db: PrismaService) {}
  // getFooByField, create, getFoos, getFoo, delFoo (+ update if needed)
}
```

## Methods
- `getFooByField({ field, value })` → look up a single row via an allow-list of
  field names (`['id', 'name', 'code']`; return nothing for any other field), return the first row (used by the
  service for duplicate / existence checks). See `StudentRepository.getStudentByField`.
- `create({ data })` → `this.db.foo.create({ data: {...} })`. Map each
  DTO field explicitly; pass `Decimal` columns as strings.
- `getFoos({ userId, query })` → build the where with `buildListWhereClause({ search,
  searchableColumns, filters, filterColumns })` (the object-shaped signature — see below),
  AND in ownership/relation conditions, then `Promise.all([count({ where }), findMany({ where, take, skip, orderBy })])`.
  Return `{ foos: rows, pagination: { total, page, limit, totalPages } }` — the list key is
  named after the resource (e.g. `students`), NOT `data`. See
  `StudentRepository.getAllStudents`.
- `getFoo({ id })` → `findUnique({ where: { id } })`, return the row or `null`.
- `delFoo({ id })` → `deleteMany({ where: { id } })`, return `count > 0`.

## buildListWhereClause signature (object-shaped, from @packages/helpers)
Columns are Prisma **model field names**; the generic is the model's `WhereInput`.
```ts
const searchWhere = buildListWhereClause<Prisma.FooWhereInput>({
  search,
  searchableColumns: { name: { column: 'name' }, code: { column: 'code' } },
  filters: { status, subject },
  filterColumns: { status: { column: 'status' }, subject: { column: 'subject' } },
});
const where: Prisma.FooWhereInput = { AND: [searchWhere ?? {}, { tutorId: userId }] };
```

## Child-resource variants
(No surviving example after the 2026-09-12 trim removed the old `class`/`schedule` features.)
A child of some parent resource has no owner column of its own, so it skips
`buildListWhereClause` and lists by parent instead:
- `createMany({ parentId, items })` → one `createManyAndReturn({ data: items.map(...) })`
  multi-row insert (never a loop of single inserts).
- `getByParent({ parentId })` → `findMany({ where: { parentId }, orderBy })`, return all rows.
- `getById({ id })`, `update({ id, data })`, `del({ id })` as usual.

## Rules
- Never inline SQL string building — reuse `buildListWhereClause` from `@packages/helpers`.
- Map camelCase DTO fields explicitly on insert. Prisma `update`/`delete` need a unique where — use `updateMany`/`deleteMany` for role/owner-scoped writes.
