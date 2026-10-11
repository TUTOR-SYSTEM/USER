import { Test } from '@nestjs/testing';
import { DRIZZLE } from 'src/database/database.module';
import { AdminRepository } from 'src/features/admin/admin.repository';
import { makeDrizzleMock } from '../../support/drizzle-mock';

describe('AdminRepository', () => {
  const ID = '11111111-1111-4111-8111-111111111111';
  const PARENT = '22222222-2222-4222-8222-222222222222';

  async function build(results: unknown[]) {
    const mock = makeDrizzleMock(results);
    const moduleRef = await Test.createTestingModule({
      providers: [AdminRepository, { provide: DRIZZLE, useValue: mock.db }],
    }).compile();
    return { repo: moduleRef.get(AdminRepository), ...mock };
  }

  describe('uniqueness lookups', () => {
    it.each([
      ['findByEmail', 'a@b.c'],
      ['findByUsername', 'user1'],
      ['findByUserCode', 'C1'],
    ] as const)('%s resolves with the matching id rows', async (method, value) => {
      const { repo, calls } = await build([[{ id: ID }]]);
      await expect((repo[method] as (v: string) => Promise<unknown>)(value)).resolves.toEqual([
        { id: ID },
      ]);
      expect(calls.select).toHaveBeenCalledTimes(1);
    });
  });

  describe('create', () => {
    it('inserts and returns the public projection of the new row', async () => {
      const { repo, calls } = await build([[{ id: ID, email: 'a@b.c' }]]);
      await expect(repo.create({ id: ID, email: 'a@b.c' } as never)).resolves.toEqual({
        id: ID,
        email: 'a@b.c',
      });
      expect(calls.insert).toHaveBeenCalledTimes(1);
    });
  });

  describe('findByIdAndRole / findStudentDetail / existsWithRole', () => {
    it('findByIdAndRole returns the row or null', async () => {
      const hit = await build([[{ id: ID }]]);
      await expect(hit.repo.findByIdAndRole(ID, 'TUTOR')).resolves.toEqual({ id: ID });
      const miss = await build([[]]);
      await expect(miss.repo.findByIdAndRole(ID, 'TUTOR')).resolves.toBeNull();
    });

    it('findStudentDetail returns the row or null and is a single query', async () => {
      const hit = await build([[{ id: ID, parentId: PARENT }]]);
      await expect(hit.repo.findStudentDetail(ID)).resolves.toEqual({ id: ID, parentId: PARENT });
      expect(hit.calls.select).toHaveBeenCalledTimes(1);
      const miss = await build([[]]);
      await expect(miss.repo.findStudentDetail(ID)).resolves.toBeNull();
    });

    it('existsWithRole is true only when a matching row exists', async () => {
      const yes = await build([[{ id: ID }]]);
      await expect(yes.repo.existsWithRole(ID, 'PARENT')).resolves.toBe(true);
      const no = await build([[]]);
      await expect(no.repo.existsWithRole(ID, 'PARENT')).resolves.toBe(false);
    });
  });

  describe('findParentInfo', () => {
    it('returns the parent row or null', async () => {
      const hit = await build([[{ id: PARENT, relationship: 'MOTHER' }]]);
      await expect(hit.repo.findParentInfo(PARENT)).resolves.toEqual({
        id: PARENT,
        relationship: 'MOTHER',
      });
      const miss = await build([[]]);
      await expect(miss.repo.findParentInfo(PARENT)).resolves.toBeNull();
    });
  });

  describe('updateByIdAndRole / deleteByIdAndRole', () => {
    it('updateByIdAndRole returns the updated public row, or null when the role does not match', async () => {
      const hit = await build([[{ id: ID, firstName: 'New' }]]);
      await expect(
        hit.repo.updateByIdAndRole(ID, 'STUDENT', { firstName: 'New' }),
      ).resolves.toEqual({
        id: ID,
        firstName: 'New',
      });
      const miss = await build([[]]);
      await expect(
        miss.repo.updateByIdAndRole(ID, 'STUDENT', { firstName: 'X' }),
      ).resolves.toBeNull();
    });

    it('deleteByIdAndRole returns the deleted id, or null when nothing matched', async () => {
      const hit = await build([[{ id: ID }]]);
      await expect(hit.repo.deleteByIdAndRole(ID, 'TUTOR')).resolves.toEqual({ id: ID });
      const miss = await build([[]]);
      await expect(miss.repo.deleteByIdAndRole(ID, 'TUTOR')).resolves.toBeNull();
    });
  });

  describe('list', () => {
    it('returns rows with pagination computed from the count', async () => {
      const { repo } = await build([[{ total: '25' }], [{ id: ID }]]);
      await expect(repo.list({ role: 'STUDENT', page: 2, limit: 10 })).resolves.toEqual({
        rows: [{ id: ID }],
        pagination: { total: 25, page: 2, limit: 10, totalPages: 3 },
      });
    });

    it('reports zero total and zero pages when nothing matches', async () => {
      const { repo } = await build([[{ total: 0 }], []]);
      await expect(repo.list({ role: 'TUTOR', page: 1, limit: 10 })).resolves.toEqual({
        rows: [],
        pagination: { total: 0, page: 1, limit: 10, totalPages: 0 },
      });
    });

    it('treats a missing count row as zero rows', async () => {
      const { repo } = await build([[], []]);
      await expect(repo.list({ role: 'TUTOR', page: 1, limit: 10 })).resolves.toEqual({
        rows: [],
        pagination: { total: 0, page: 1, limit: 10, totalPages: 0 },
      });
    });

    it('runs the count and the page query in parallel (two selects)', async () => {
      const { repo, calls } = await build([[{ total: 1 }], [{ id: ID }]]);
      await repo.list({ role: 'TUTOR', page: 1, limit: 5, search: 'x', isActive: true });
      expect(calls.select).toHaveBeenCalledTimes(2);
    });

    it('ignores a whitespace-only search and keeps only the role condition', async () => {
      const { repo } = await build([[{ total: 0 }], []]);
      await expect(
        repo.list({ role: 'STUDENT', page: 1, limit: 10, search: '   ' }),
      ).resolves.toMatchObject({ pagination: { total: 0 } });
    });

    it('accepts isActive=false as a real filter value', async () => {
      const { repo } = await build([[{ total: 0 }], []]);
      await expect(
        repo.list({ role: 'STUDENT', page: 1, limit: 10, isActive: false }),
      ).resolves.toMatchObject({ rows: [] });
    });
  });
});
