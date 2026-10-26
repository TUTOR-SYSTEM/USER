---
name: generate-service
description: Scaffold the service layer (src/features/{name}/{name}.service.ts) — business logic with Logger, UUID validation, owner/existence checks, NotFound/BadRequest/Conflict handling, delegating to the repository. Use when asked to create/add a service or business-logic layer for a feature in this NestJS tutoring backend.
---

# Generate Service

Create `src/features/foo/foo.service.ts`. The `class` feature this skill originally mirrored
was removed in a 2026-09-12 trim — follow the shape below; `user.service.ts` is the closest
surviving example of the `...Service` suffix + validate-then-delegate convention.

## Prerequisites
- `FooRepository` exists (see `generate-repository`).
- DTOs exist under `@packages/entities/foo`.

## Shape
```ts
import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { CreateFooDto, GetFoosQueryDto } from '@packages/entities/foo';
import { checkUuidValid, generateCode } from '@packages/helpers';
import { FooRepository } from './foo.repository';
import { UserService } from '../user/user.service';

@Injectable()
export class FooService {
  private readonly logger = new Logger(FooService.name);
  constructor(
    private readonly repo: FooRepository,
    private readonly user: UserService, // + other feature services it depends on
  ) {}
  // createFooService, getFoosService, getFooService, delFooService
}
```

## Methods (note the `...Service` suffix)
- `createFooService({ userId, data })` — validate `userId` is a UUID (`checkUuidValid`),
  confirm the user exists via `this.user.getUserByField({ field: 'id', value: userId })`,
  duplicate-check unique fields via `this.repo.getFooByField({ field, value })`, validate any
  FK ids (e.g. `tutorId`) the same way, then `this.repo.create({ data })`.
- `getFoosService({ userId, query })` — validate `userId`, confirm user exists, then
  `this.repo.getFoos({ userId, query })`.
- `getFooService({ userId, id })` — validate `userId`, confirm user exists, then
  `this.repo.getFoo({ id })`.
- `delFooService({ userId, id })` — validate both UUIDs, confirm user + row exist, enforce
  ownership (`row.tutorId !== userId` → `NotFoundException`), then `this.repo.delFoo({ id })`.
- If the domain needs a unique human code, add `generateNewCodeService()` — loop
  `generateCode()` (from `@packages/helpers`) with a MAX_RETRIES cap, `ConflictException` on
  exhaustion (see `StudentService.generateUniqueCode`).

## Child resources owned through a parent
(No surviving example after the 2026-09-12 trim removed the old `class`/`schedule`/`session`
child-resource features — apply this pattern from scratch when a new feature needs it.)
When the feature is a child of some parent resource `bar` and has no `tutorId` of its own,
authorize **through the parent** instead of re-checking the user table:
- Inject the parent's service (`private readonly barService: BarService`) and import
  `BarModule` in the feature module.
- Add a private guard that loads the parent and enforces ownership, reused by every method:
  ```ts
  private async assertBarOwner({ userId, barId }: { userId: string; barId: string }) {
    if (!barId || !checkUuidValid({ data: barId }))
      throw new BadRequestException('Bar Id must be uuid ...');
    const barData = await this.barService.getBarService({ userId, id: barId });
    if (!barData || (Array.isArray(barData) && barData.length === 0))
      throw new NotFoundException('Bar not found ...');
    if (barData.tutorId !== userId) throw new NotFoundException('Bar not found ...');
    return barData;
  }
  ```
- For get/update/delete by the child's own id, first load the child row, then call
  `assertBarOwner({ userId, barId: row.barId })`. Return `NotFoundException` (not `Forbidden`)
  on an ownership miss so records aren't enumerable.
- List by parent instead of a global paginated list: `get{Children}ByParentService({ userId,
  parentId })` → guard, then `repo.getByParent({ parentId })`.

## Bulk create
For a `{ parentId, items: [...] }` bulk schema, add `create{Children}Service({ userId, data })`
that runs the parent-owner guard once, then delegates to a single `repo.createMany({ parentId,
items })` (one multi-row insert — do NOT loop single inserts).

## Rules
- Validate every UUID param with `checkUuidValid({ data: id })` before hitting the DB.
- `BadRequestException` for bad input, `NotFoundException` when a row is missing / not owned,
  `ConflictException` for unresolvable uniqueness collisions.
- Inject sibling feature services (`UserService`, `AdminService`, …) rather than
  re-querying their tables directly; import their modules in `foo.module.ts`.
- Keep all database access in the repository; services never inject `PrismaService`.
