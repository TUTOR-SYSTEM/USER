---
name: generate-repository
description: Scaffold the repository layer (src/features/{name}/{name}.repository.ts) — Drizzle DB access with DRIZZLE injection, CRUD + paginated list using buildListWhereClause. Use when asked to create/add a repository or data-access layer for a feature in this NestJS tutoring backend.
---

# Generate Repository

Create `src/features/foo/foo.repository.ts`. The `class` feature this skill originally
mirrored was removed in a 2026-09-12 trim — follow the shape below; `student.repository.ts` /
`user.repository.ts` are the closest surviving examples of `buildListWhereClause` +
pagination.

## Prerequisites
- The Drizzle table (e.g. `foos`) exists in `src/database/schema.ts` (local mirror of gateway's canonical schema).
- The DTOs exist under `@packages/entities/foo` (see `generate-entity`).

## Shape
```ts
import { Inject, Injectable } from '@nestjs/common';
import { and, count, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import { DRIZZLE } from '../../database/database.module';
import { CreateFooDto, GetFoosQueryDto } from '@packages/entities/foo';
import { foos } from '@packages/database/schema';
import { buildListWhereClause } from '@packages/helpers';

@Injectable()
export class FooRepository {
  constructor(@Inject(DRIZZLE) private readonly db: ReturnType<typeof drizzle>) {}
  // getFooByField, create, getFoos, getFoo, delFoo (+ update if needed)
}
```

## Methods
- `getFooByField({ field, value })` → look up a single row via a `fieldMaps` object
  (`{ id: foos.id, name: foos.name, code: foos.code }`), return the first row (used by the
  service for duplicate / existence checks). See `StudentRepository.getStudentByField`.
- `create({ data })` → `.insert(foos).values({...}).returning()`, return first row. Map each
  DTO field explicitly; `.toString()` any `numeric`-column values.
- `getFoos({ userId, query })` → build the where with `buildListWhereClause({ search,
  searchableColumns, filters, filterColumns })` (the object-shaped signature — see below),
  AND in ownership/relation conditions, count total, then paged `.select().limit().offset()`.
  Return `{ foos: rows, pagination: { total, page, limit, totalPages } }` — the list key is
  named after the resource (e.g. `students`), NOT `data`. See
  `StudentRepository.getAllStudents`.
- `getFoo({ id })` → `.where(eq(foos.id, id)).limit(1)`, return the row or `[]`.
- `delFoo({ id })` → `.delete(...).returning()`, return a boolean (`!!row`).

## buildListWhereClause signature (object-shaped, from @packages/helpers)
```ts
const searchWhere = buildListWhereClause({
  search,
  searchableColumns: { name: { column: foos.name }, code: { column: foos.code } },
  filters: { status, subject },
  filterColumns: { status: { column: foos.status }, subject: { column: foos.subject } },
});
const whereClause = and(...[searchWhere, eq(foos.tutorId, userId)].filter((c) => c !== undefined));
```

## Child-resource variants
(No surviving example after the 2026-09-12 trim removed the old `class`/`schedule` features.)
A child of some parent resource has no owner column of its own, so it skips
`buildListWhereClause` and lists by parent instead:
- `createMany({ parentId, items })` → one `.insert(foos).values(items.map(...)).returning()`
  multi-row insert (never a loop of single inserts).
- `getByParent({ parentId })` → `.where(eq(foos.parentId, parentId)).orderBy(...)`, return all rows.
- `getById({ id })`, `update({ id, data })`, `del({ id })` as usual.

## Rules
- Never inline SQL string building — reuse `buildListWhereClause` from `@packages/helpers`.
- Map camelCase DTO fields to columns explicitly on insert; stringify `numeric` columns.
