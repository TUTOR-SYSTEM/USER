import { Test } from '@nestjs/testing';
import { DRIZZLE } from 'src/database/database.module';
import { UserRepository } from 'src/features/user/user.repository';
import { makeDrizzleMock } from '../../support/drizzle-mock';

describe('UserRepository', () => {
  const ID = '11111111-1111-4111-8111-111111111111';

  async function build(results: unknown[]) {
    const mock = makeDrizzleMock(results);
    const moduleRef = await Test.createTestingModule({
      providers: [UserRepository, { provide: DRIZZLE, useValue: mock.db }],
    }).compile();
    return { repo: moduleRef.get(UserRepository), ...mock };
  }

  describe('findByField', () => {
    it.each(['id', 'email', 'username', 'phone', 'userCode'] as const)(
      'queries by the %s column',
      async (field) => {
        const { repo, calls } = await build([[{ id: ID }]]);
        await expect(repo.findByField(field, 'v')).resolves.toEqual([{ id: ID }]);
        expect(calls.select).toHaveBeenCalledTimes(1);
      },
    );

    it('returns an empty list and issues no query for an unmapped field', async () => {
      const { repo, calls } = await build([]);
      await expect(repo.findByField('password' as never, 'x')).resolves.toEqual([]);
      expect(calls.select).not.toHaveBeenCalled();
    });
  });

  describe('single-row lookups', () => {
    it('findById returns the row or null', async () => {
      const found = await build([[{ id: ID }]]);
      await expect(found.repo.findById(ID)).resolves.toEqual({ id: ID });
      const missing = await build([[]]);
      await expect(missing.repo.findById(ID)).resolves.toBeNull();
    });

    it('findWithPassword returns the row or null', async () => {
      const found = await build([[{ id: ID, password: 'h' }]]);
      await expect(found.repo.findWithPassword(ID)).resolves.toEqual({ id: ID, password: 'h' });
      const missing = await build([[]]);
      await expect(missing.repo.findWithPassword(ID)).resolves.toBeNull();
    });

    it('findUserCode returns the row or null', async () => {
      const found = await build([[{ id: ID, userCode: 'C1' }]]);
      await expect(found.repo.findUserCode('C1')).resolves.toEqual({ id: ID, userCode: 'C1' });
      const missing = await build([[]]);
      await expect(missing.repo.findUserCode('C1')).resolves.toBeNull();
    });
  });

  describe('buildUserListConditions', () => {
    it('returns undefined when no filter is set', async () => {
      const { repo } = await build([]);
      expect(repo.buildUserListConditions({ page: 1, limit: 10 } as never)).toBeUndefined();
    });

    it('ignores a whitespace-only search', async () => {
      const { repo } = await build([]);
      expect(repo.buildUserListConditions({ search: '   ' } as never)).toBeUndefined();
    });

    it('returns a single condition unwrapped when only one filter is set', async () => {
      const { repo } = await build([]);
      expect(repo.buildUserListConditions({ role: 'TUTOR' } as never)).toBeDefined();
    });

    it('combines search, role and isActive with AND when all are set', async () => {
      const { repo } = await build([]);
      expect(
        repo.buildUserListConditions({ search: 'an', role: 'STUDENT', isActive: false } as never),
      ).toBeDefined();
    });

    it('keeps isActive=false (falsy but set)', async () => {
      const { repo } = await build([]);
      expect(repo.buildUserListConditions({ isActive: false } as never)).toBeDefined();
    });
  });

  describe('pagination and counts', () => {
    it('paginateUsers issues one select (ordering and paging applied)', async () => {
      const { repo, calls } = await build([[{ id: ID }]]);
      await expect(repo.paginateUsers(undefined, 10, 20)).resolves.toEqual([{ id: ID }]);
      expect(calls.select).toHaveBeenCalledTimes(1);
    });

    it('countUsers returns a number, defaulting to 0 when no row', async () => {
      const counted = await build([[{ total: '7' }]]);
      await expect(counted.repo.countUsers(undefined)).resolves.toBe(7);
      const empty = await build([[]]);
      await expect(empty.repo.countUsers(undefined)).resolves.toBe(0);
    });
  });

  describe('writes', () => {
    it('create inserts and returns the new row', async () => {
      const { repo, calls } = await build([[{ id: ID }]]);
      await expect(
        repo.create({
          id: ID,
          email: 'a@b.c',
          username: 'u',
          firstName: 'A',
          lastName: 'B',
          password: 'h',
          role: 'TUTOR',
        }),
      ).resolves.toEqual({ id: ID });
      expect(calls.insert).toHaveBeenCalledTimes(1);
    });

    it('update returns the updated row, or null when nothing matched', async () => {
      const hit = await build([[{ id: ID, firstName: 'New' }]]);
      await expect(hit.repo.update(ID, { firstName: 'New' })).resolves.toEqual({
        id: ID,
        firstName: 'New',
      });
      const miss = await build([[]]);
      await expect(miss.repo.update(ID, { firstName: 'New' })).resolves.toBeNull();
    });

    it('updatePassword returns the row, or null when nothing matched', async () => {
      const hit = await build([[{ id: ID }]]);
      await expect(hit.repo.updatePassword(ID, 'hash')).resolves.toEqual({ id: ID });
      const miss = await build([[]]);
      await expect(miss.repo.updatePassword(ID, 'hash')).resolves.toBeNull();
    });

    it('delete issues a delete and returns nothing', async () => {
      const { repo, calls } = await build([[]]);
      await expect(repo.delete(ID)).resolves.toBeUndefined();
      expect(calls.delete).toHaveBeenCalledTimes(1);
    });
  });

  describe('grades', () => {
    it('findGradesByUser returns [] when the user does not exist', async () => {
      const { repo, calls } = await build([[]]);
      await expect(repo.findGradesByUser(ID)).resolves.toEqual([]);
      expect(calls.select).toHaveBeenCalledTimes(1);
    });

    it('findGradesByUser returns [] without a second query when gradesId is empty', async () => {
      const { repo, calls } = await build([[{ gradesId: [] }]]);
      await expect(repo.findGradesByUser(ID)).resolves.toEqual([]);
      expect(calls.select).toHaveBeenCalledTimes(1);
    });

    it('findGradesByUser returns the grades when gradesId is set', async () => {
      const { repo, calls } = await build([[{ gradesId: ['g1'] }], [{ id: 'g1', level: 1 }]]);
      await expect(repo.findGradesByUser(ID)).resolves.toEqual([{ id: 'g1', level: 1 }]);
      expect(calls.select).toHaveBeenCalledTimes(2);
    });

    it('findGradeById returns the row or null', async () => {
      const hit = await build([[{ id: 'g1' }]]);
      await expect(hit.repo.findGradeById('g1')).resolves.toEqual({ id: 'g1' });
      const miss = await build([[]]);
      await expect(miss.repo.findGradeById('g1')).resolves.toBeNull();
    });

    it('updateGrade writes name and level and returns the row or null', async () => {
      const hit = await build([[{ id: 'g1', name: 'N', level: 2 }]]);
      await expect(hit.repo.updateGrade('g1', { name: 'N', level: 2 } as never)).resolves.toEqual({
        id: 'g1',
        name: 'N',
        level: 2,
      });
      const miss = await build([[]]);
      await expect(
        miss.repo.updateGrade('g1', { name: 'N', level: 2 } as never),
      ).resolves.toBeNull();
    });

    it('validateGradeIds returns the matching grade rows', async () => {
      const { repo } = await build([[{ id: 'g1' }, { id: 'g2' }]]);
      await expect(repo.validateGradeIds(['g1', 'g2', 'gX'])).resolves.toEqual([
        { id: 'g1' },
        { id: 'g2' },
      ]);
    });
  });
});
